// git-updater installer helper (PROJECT-one-admin-prompt.md).
//
// git-updater never runs as administrator. When installers need administrator rights it
// writes them into a job list (see job.rs) and starts this program, which asks Windows for
// permission ONCE and runs them all.
//
//   git-updater-helper.exe --verify --job <job file>
//     Not elevated, installs nothing. Runs the checks on each file where it is and prints the
//     results, so git-updater knows beforehand which installers the helper would refuse.
//
//   git-updater-helper.exe --install --job <job file>
//     Not elevated. Reads the job, asks Windows to start this same program with
//     administrator rights (the one prompt), waits for it, and prints the results.
//
//   git-updater-helper.exe --elevated-run --job <job file> --token <32 hex>
//     Elevated; only ever started by the line above. For each installer: copy it into a new
//     folder only administrators can write to, check THAT COPY (kind, SHA-256, Authenticode
//     signature), run that copy, record its exit code, remove the copy. Then hand the
//     results back and exit.
//
//   git-updater-helper.exe --who-uses --folder <folder>
//     Not elevated, installs nothing, changes nothing. Prints which programs have files under
//     the folder open, one "<process id><TAB><name>" line each (see inuse.rs), so a failed
//     installer can say what to close.
//
// Rules this program keeps:
//   - It runs nothing but the installer files in the job, or Windows' own msiexec for an MSI.
//   - It never runs a file from a folder the user account can write to.
//   - It writes only inside the folder it created; never to a path it was given.
//   - No sockets, no pipes, no shell. Nothing stays running or elevated when it exits.
//   - Everything in the job is untrusted: any program running as the user can write one.
#![cfg_attr(not(test), windows_subsystem = "windows")]

mod check;
mod inuse;
mod job;

use std::ffi::{c_void, OsStr, OsString};
use std::fs;
use std::io::{Read, Write};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::FromRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{exit, Command, Stdio};
use std::ptr::{null, null_mut};
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, LocalFree, ERROR_CANCELLED, HANDLE, INVALID_HANDLE_VALUE, WAIT_TIMEOUT};
use windows_sys::Win32::Security::Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
use windows_sys::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};
use windows_sys::Win32::Security::{GetTokenInformation, TokenElevation, SECURITY_ATTRIBUTES, TOKEN_ELEVATION, TOKEN_QUERY};
use windows_sys::Win32::Storage::FileSystem::{CreateDirectoryW, CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_WRITE};
use windows_sys::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_APARTMENTTHREADED};
use windows_sys::Win32::System::LibraryLoader::{SetDefaultDllDirectories, LOAD_LIBRARY_SEARCH_SYSTEM32};
use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetExitCodeProcess, OpenProcessToken, WaitForSingleObject, CREATE_NO_WINDOW,
};
use windows_sys::Win32::UI::Shell::{
    FOLDERID_ProgramData, SHGetKnownFolderPath, ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
};

use check::{check_file, wide};
use job::{format_results, parse_job, Item, Job, Kind, Switches, MAX_JOB_BYTES};

// The helper's own codes. As the program's exit code they describe the whole run; in a
// results line they describe one installer that was never started. Any other number in a
// results line is that installer's own exit code (0 and 3010 mean it succeeded).
pub const EXIT_OK: u32 = 0;
pub const EXIT_DECLINED: u32 = 1223; // the Windows prompt was answered No, or it timed out
pub const EXIT_BAD_ARGUMENTS: u32 = 64001; // the command line or the job list is not as specified
pub const EXIT_ELEVATION_FAILED: u32 = 64002;
pub const EXIT_NOT_ELEVATED: u32 = 64003;
pub const EXIT_NO_SAFE_FOLDER: u32 = 64004;
pub const EXIT_COPY_FAILED: u32 = 64005;
pub const EXIT_HASH_MISMATCH: u32 = 64006;
pub const EXIT_NOT_SIGNED: u32 = 64007;
pub const EXIT_COULD_NOT_START: u32 = 64008;
pub const EXIT_TIMED_OUT: u32 = 64009;
pub const EXIT_NO_RESULTS: u32 = 64010;
pub const EXIT_NOT_AN_INSTALLER: u32 = 64011;

const QUOTE: u16 = 0x22;
const BACKSLASH: u16 = 0x5c;
const FOLDER_PREFIX: &str = "git-updater-helper-";
const RESULTS_NAME: &str = "results.txt";

// The run folder: SYSTEM and Administrators have full control, inherited by everything made
// inside it; ordinary users may pass through it (to reach the results file) and nothing more.
const FOLDER_ACCESS: &str = "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;FX;;;BU)";
// The results file: ordinary users may read it and delete it, so the not-elevated half can
// collect it. They cannot change it.
const RESULTS_ACCESS: &str = "O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRSD;;;BU)";

fn from_wide(buf: &[u16]) -> OsString {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    OsString::from_wide(&buf[..len])
}

// One argument, quoted the way Windows' own argument parser reads it back.
fn quote(arg: &OsStr) -> Vec<u16> {
    let mut out: Vec<u16> = vec![QUOTE];
    let mut backslashes = 0usize;
    for c in arg.encode_wide() {
        if c == BACKSLASH {
            backslashes += 1;
        } else if c == QUOTE {
            out.extend(std::iter::repeat(BACKSLASH).take(backslashes + 1));
            backslashes = 0;
        } else {
            backslashes = 0;
        }
        out.push(c);
    }
    out.extend(std::iter::repeat(BACKSLASH).take(backslashes));
    out.push(QUOTE);
    out
}

fn read_job(path: &Path) -> Option<Job> {
    let file = fs::File::open(path).ok()?;
    if file.metadata().ok()?.len() > MAX_JOB_BYTES {
        return None;
    }
    let mut text = String::new();
    file.take(MAX_JOB_BYTES).read_to_string(&mut text).ok()?;
    parse_job(&text)
}

fn is_token(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn new_token() -> Option<String> {
    let mut random = [0u8; 16];
    if unsafe { BCryptGenRandom(null_mut(), random.as_mut_ptr(), 16, BCRYPT_USE_SYSTEM_PREFERRED_RNG) } != 0 {
        return None;
    }
    Some(random.iter().map(|b| format!("{b:02x}")).collect())
}

fn is_elevated() -> bool {
    unsafe {
        let mut token: HANDLE = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut size = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            &mut elevation as *mut _ as *mut c_void,
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut size,
        );
        CloseHandle(token);
        ok != 0 && elevation.TokenIsElevated != 0
    }
}

// %ProgramData% and System32 as Windows reports them, never from environment variables
// (the program that started us chose those).
fn program_data() -> Option<PathBuf> {
    unsafe {
        let mut raw = null_mut();
        if SHGetKnownFolderPath(&FOLDERID_ProgramData, 0, null_mut(), &mut raw) != 0 || raw.is_null() {
            return None;
        }
        let mut len = 0usize;
        while *raw.add(len) != 0 {
            len += 1;
        }
        let path = PathBuf::from(OsString::from_wide(std::slice::from_raw_parts(raw, len)));
        CoTaskMemFree(raw as *const c_void);
        Some(path)
    }
}

fn system_dir() -> Option<PathBuf> {
    let mut buf = [0u16; 512];
    let len = unsafe { GetSystemDirectoryW(buf.as_mut_ptr(), buf.len() as u32) } as usize;
    if len == 0 || len >= buf.len() {
        return None;
    }
    Some(PathBuf::from(from_wide(&buf)))
}

fn run_folder(token: &str) -> Option<PathBuf> {
    Some(program_data()?.join(format!("{FOLDER_PREFIX}{token}")))
}

// Runs `make` with the access list written in `sddl`, so the folder or file is created
// already protected: there is no moment at which it exists with any other access.
fn with_access<T>(sddl: &str, make: impl FnOnce(&SECURITY_ATTRIBUTES) -> T) -> Option<T> {
    let sddl = wide(OsStr::new(sddl));
    unsafe {
        let mut descriptor = null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut descriptor, null_mut()) == 0 {
            return None;
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let made = make(&attributes);
        LocalFree(descriptor as _);
        Some(made)
    }
}

// A brand-new folder for this run. The name is random and the create FAILS if anything is
// already there, so nobody can prepare the folder for us.
fn make_run_folder(token: &str) -> Option<PathBuf> {
    let dir = run_folder(token)?;
    let path = wide(dir.as_os_str());
    let created = with_access(FOLDER_ACCESS, |attributes| unsafe { CreateDirectoryW(path.as_ptr(), attributes) })?;
    (created != 0).then_some(dir)
}

fn write_results(folder: &Path, results: &[(usize, u32)]) -> bool {
    let draft = folder.join("results.tmp");
    let path = wide(draft.as_os_str());
    let handle = with_access(RESULTS_ACCESS, |attributes| unsafe {
        CreateFileW(path.as_ptr(), FILE_GENERIC_WRITE, 0, attributes, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, null_mut())
    });
    let Some(handle) = handle.filter(|h| *h != INVALID_HANDLE_VALUE) else {
        return false;
    };
    let mut file = unsafe { fs::File::from_raw_handle(handle as _) };
    let written = file.write_all(format_results(results).as_bytes()).is_ok();
    drop(file);
    // Renamed into place only when complete, so the reader never sees half a file.
    written && fs::rename(&draft, folder.join(RESULTS_NAME)).is_ok()
}

fn start(item: &Item, copy: &Path, system: &Path) -> Command {
    let mut command = match item.kind {
        Kind::Msi => {
            let mut command = Command::new(system.join("msiexec.exe"));
            match &item.switches {
                Switches::Args(args) => {
                    command.arg("/i").arg(copy).args(args);
                }
                Switches::Raw(line) => {
                    let mut tail = OsString::from("/i \"");
                    tail.push(copy);
                    tail.push("\" ");
                    tail.push(line);
                    command.raw_arg(tail);
                }
            }
            command
        }
        Kind::Exe => {
            let mut command = Command::new(copy);
            match &item.switches {
                Switches::Args(args) => {
                    command.args(args);
                }
                Switches::Raw(line) => {
                    command.raw_arg(line);
                }
            }
            command
        }
    };
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(CREATE_NO_WINDOW);
    command
}

// Copy into `folder`, check the copy, run the copy. Returns the installer's exit code, or
// the helper code for why it was not run.
fn install_one(item: &Item, folder: &Path, system: &Path, timeout: Duration) -> u32 {
    let Some(name) = item.file.file_name() else {
        return EXIT_NOT_AN_INSTALLER;
    };
    let copy = folder.join(name);
    let copied = (|| -> std::io::Result<u64> {
        let mut from = fs::File::open(&item.file)?;
        let mut to = fs::OpenOptions::new().write(true).create_new(true).open(&copy)?;
        std::io::copy(&mut from, &mut to)
    })();
    let code = if copied.is_err() {
        EXIT_COPY_FAILED
    } else {
        match check_file(item.kind, &copy, &item.sha256) {
            EXIT_OK => run(start(item, &copy, system).current_dir(folder), timeout),
            refused => refused,
        }
    };
    let _ = fs::remove_file(&copy);
    code
}

fn run(command: &mut Command, timeout: Duration) -> u32 {
    let Ok(mut child) = command.spawn() else {
        return EXIT_COULD_NOT_START;
    };
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.code().map_or(EXIT_COULD_NOT_START, |c| c as u32),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(200)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return EXIT_TIMED_OUT;
            }
        }
    }
}

// Elevated: the whole batch.
fn elevated_run(job_path: &Path, token: &str) -> u32 {
    if !is_elevated() {
        return EXIT_NOT_ELEVATED;
    }
    let Some(system) = system_dir() else {
        return EXIT_NO_SAFE_FOLDER;
    };
    // Never work from the folder we were started in: the user account may be able to write there.
    let _ = std::env::set_current_dir(&system);
    let Some(job) = read_job(job_path) else {
        return EXIT_BAD_ARGUMENTS;
    };
    let Some(folder) = make_run_folder(token) else {
        return EXIT_NO_SAFE_FOLDER;
    };
    let timeout = Duration::from_secs(job.timeout_secs);
    let mut results = Vec::with_capacity(job.items.len());
    for (index, item) in job.items.iter().enumerate() {
        // One sub-folder each, so two installers with the same file name cannot collide.
        let own = folder.join(index.to_string());
        let code = if fs::create_dir(&own).is_ok() { install_one(item, &own, &system, timeout) } else { EXIT_COPY_FAILED };
        let _ = fs::remove_dir(&own);
        results.push((index, code));
    }
    let handed_over = write_results(&folder, &results);
    if handed_over {
        // The not-elevated half deletes the file once it has read it. Give it a moment.
        let taken_by = Instant::now() + Duration::from_secs(15);
        while folder.join(RESULTS_NAME).exists() && Instant::now() < taken_by {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    let _ = fs::remove_file(folder.join(RESULTS_NAME));
    let _ = fs::remove_file(folder.join("results.tmp"));
    let _ = fs::remove_dir(&folder);
    if handed_over {
        EXIT_OK
    } else {
        EXIT_NO_RESULTS
    }
}

fn take_results(file: &Path) -> Option<String> {
    let text = fs::read_to_string(file).ok()?;
    let _ = fs::remove_file(file);
    Some(text)
}

// Not elevated: ask Windows to start this same program elevated (the one prompt), wait for
// it, and pass its results on.
fn ask_and_wait(job_path: &Path) -> u32 {
    if read_job(job_path).is_none() {
        return EXIT_BAD_ARGUMENTS; // do not ask for permission to run a job that will be refused
    }
    let (Ok(me), Some(token)) = (std::env::current_exe(), new_token()) else {
        return EXIT_ELEVATION_FAILED;
    };
    let Some(results_file) = run_folder(&token).map(|f| f.join(RESULTS_NAME)) else {
        return EXIT_ELEVATION_FAILED;
    };
    let mut params: Vec<u16> = "--elevated-run --job ".encode_utf16().collect();
    params.extend(quote(job_path.as_os_str()));
    params.extend(" --token ".encode_utf16());
    params.extend(token.encode_utf16());
    params.push(0);
    let verb = wide(OsStr::new("runas"));
    let file = wide(me.as_os_str());
    unsafe {
        CoInitializeEx(null(), COINIT_APARTMENTTHREADED as u32);
        let mut info: SHELLEXECUTEINFOW = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
        info.lpVerb = verb.as_ptr();
        info.lpFile = file.as_ptr();
        info.lpParameters = params.as_ptr();
        info.nShow = 0; // SW_HIDE: the helper has no window
        if ShellExecuteExW(&mut info) == 0 {
            return if GetLastError() == ERROR_CANCELLED { EXIT_DECLINED } else { EXIT_ELEVATION_FAILED };
        }
        if info.hProcess.is_null() {
            return EXIT_ELEVATION_FAILED;
        }
        let mut results = None;
        while WaitForSingleObject(info.hProcess, 50) == WAIT_TIMEOUT {
            if results.is_none() {
                results = take_results(&results_file);
            }
        }
        let mut code = EXIT_ELEVATION_FAILED;
        GetExitCodeProcess(info.hProcess, &mut code);
        CloseHandle(info.hProcess);
        match results.or_else(|| take_results(&results_file)) {
            Some(text) => {
                let _ = std::io::stdout().write_all(text.as_bytes());
                EXIT_OK
            }
            None if code == EXIT_OK => EXIT_NO_RESULTS,
            None => code,
        }
    }
}

// Not elevated, installs nothing: the same checks, on each file where it is.
fn verify(job_path: &Path) -> u32 {
    let Some(job) = read_job(job_path) else {
        return EXIT_BAD_ARGUMENTS;
    };
    let results: Vec<(usize, u32)> =
        job.items.iter().enumerate().map(|(index, item)| (index, check_file(item.kind, &item.file, &item.sha256))).collect();
    let _ = std::io::stdout().write_all(format_results(&results).as_bytes());
    EXIT_OK
}

// `--who-uses`: which programs have files under `folder` open. Read-only.
fn who_uses(folder: &Path) -> u32 {
    if !folder.is_absolute() || !folder.is_dir() {
        return EXIT_BAD_ARGUMENTS;
    }
    let Some(users) = inuse::users_of(&inuse::files_under(folder)) else {
        return EXIT_NO_RESULTS;
    };
    let _ = std::io::stdout().write_all(inuse::format_users(&users).as_bytes());
    EXIT_OK
}

fn main() {
    // Load Windows' own libraries from System32 only, never from the folder this program
    // sits in (the build also sets this for the libraries loaded before this line runs).
    unsafe { SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32) };
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let text: Vec<Option<&str>> = args.iter().map(|a| a.to_str()).collect();
    let code = match text.as_slice() {
        [Some("--verify"), Some("--job"), Some(job)] => verify(Path::new(job)),
        [Some("--install"), Some("--job"), Some(job)] => ask_and_wait(Path::new(job)),
        [Some("--who-uses"), Some("--folder"), Some(folder)] => who_uses(Path::new(folder)),
        [Some("--elevated-run"), Some("--job"), Some(job), Some("--token"), Some(token)] if is_token(token) => {
            elevated_run(Path::new(job), token)
        }
        _ => EXIT_BAD_ARGUMENTS,
    };
    exit(code as i32);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gu-helper-main-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn item(file: PathBuf, kind: Kind) -> Item {
        let sha256 = check::sha256_of(&file).unwrap_or_else(|| "0".repeat(64));
        Item { file, sha256, kind, switches: Switches::Args(vec![]) }
    }

    fn argv(text: &[u16]) -> String {
        String::from_utf16(text).unwrap()
    }

    #[test]
    fn arguments_are_quoted_the_way_windows_reads_them_back() {
        assert_eq!(argv(&quote(OsStr::new("C:\\a b\\job.txt"))), "\"C:\\a b\\job.txt\"");
        assert_eq!(argv(&quote(OsStr::new("C:\\dir\\"))), "\"C:\\dir\\\\\"", "a trailing backslash must not swallow the quote");
        assert_eq!(argv(&quote(OsStr::new("a\"b"))), "\"a\\\"b\"");
        assert_eq!(argv(&quote(OsStr::new("a\\\"b"))), "\"a\\\\\\\"b\"");
    }

    #[test]
    fn only_a_token_this_program_makes_is_accepted() {
        let token = new_token().unwrap();
        assert!(is_token(&token));
        assert_ne!(token, new_token().unwrap());
        for bad in ["", "abc", "..\\..\\windows", &"g".repeat(32), &"A".repeat(32), &"a".repeat(33)] {
            assert!(!is_token(bad), "{bad}");
        }
    }

    #[test]
    fn an_unsigned_installer_is_copied_checked_and_never_run() {
        let from = scratch("unsigned-from");
        let to = scratch("unsigned-to");
        let file = from.join("setup.exe");
        fs::write(&file, b"MZ not a real program").unwrap();
        let code = install_one(&item(file, Kind::Exe), &to, &system_dir().unwrap(), Duration::from_secs(5));
        assert_eq!(code, EXIT_NOT_SIGNED);
        assert_eq!(fs::read_dir(&to).unwrap().count(), 0, "the copy is removed");
    }

    #[test]
    fn a_file_swapped_after_its_hash_was_taken_is_never_run() {
        let from = scratch("swap-from");
        let to = scratch("swap-to");
        let file = from.join("setup.exe");
        fs::write(&file, b"MZ what git-updater downloaded").unwrap();
        let listed = item(file.clone(), Kind::Exe);
        fs::write(&file, b"MZ what someone put there afterwards").unwrap();
        assert_eq!(install_one(&listed, &to, &system_dir().unwrap(), Duration::from_secs(5)), EXIT_HASH_MISMATCH);
        assert_eq!(fs::read_dir(&to).unwrap().count(), 0);
    }

    #[test]
    fn things_that_are_not_installers_are_never_run() {
        let from = scratch("other-from");
        let to = scratch("other-to");
        let system = system_dir().unwrap();
        let script = from.join("run.cmd");
        fs::write(&script, b"echo hi").unwrap();
        assert_eq!(install_one(&item(script, Kind::Exe), &to, &system, Duration::from_secs(5)), EXIT_NOT_AN_INSTALLER);
        let renamed = from.join("script.exe");
        fs::write(&renamed, b"echo hi").unwrap();
        assert_eq!(install_one(&item(renamed, Kind::Exe), &to, &system, Duration::from_secs(5)), EXIT_NOT_AN_INSTALLER);
        assert_eq!(install_one(&item(from.join("missing.msi"), Kind::Msi), &to, &system, Duration::from_secs(5)), EXIT_COPY_FAILED);
        assert_eq!(fs::read_dir(&to).unwrap().count(), 0);
    }

    #[test]
    fn the_command_is_built_from_the_copy_and_the_listed_switches_only() {
        let system = PathBuf::from("C:\\Windows\\System32");
        let copy = Path::new("C:\\ProgramData\\run\\0\\app.msi");
        let listed = |kind, switches| Item { file: PathBuf::from("C:\\user\\app.msi"), sha256: "0".repeat(64), kind, switches };

        let msi = start(&listed(Kind::Msi, Switches::Args(vec!["/qn".into(), "/norestart".into()])), copy, &system);
        assert_eq!(msi.get_program(), system.join("msiexec.exe").as_os_str());
        assert_eq!(msi.get_args().collect::<Vec<_>>(), ["/i", "C:\\ProgramData\\run\\0\\app.msi", "/qn", "/norestart"]);

        let exe_copy = Path::new("C:\\ProgramData\\run\\1\\setup.exe");
        let exe = start(&listed(Kind::Exe, Switches::Args(vec!["/S".into()])), exe_copy, &system);
        assert_eq!(exe.get_program(), exe_copy.as_os_str());
        assert_eq!(exe.get_args().collect::<Vec<_>>(), ["/S"]);
    }

    #[test]
    fn a_run_that_outlives_its_limit_is_stopped() {
        let system = system_dir().unwrap();
        let mut slow = Command::new(system.join("ping.exe"));
        slow.args(["-n", "30", "127.0.0.1"]).stdout(Stdio::null()).creation_flags(CREATE_NO_WINDOW);
        let began = Instant::now();
        assert_eq!(run(&mut slow, Duration::from_millis(600)), EXIT_TIMED_OUT);
        assert!(began.elapsed() < Duration::from_secs(10));
        let mut quick = Command::new(system.join("whoami.exe"));
        quick.stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(CREATE_NO_WINDOW);
        assert_eq!(run(&mut quick, Duration::from_secs(20)), 0);
        assert_eq!(run(&mut Command::new("C:\\no\\such\\program.exe"), Duration::from_secs(1)), EXIT_COULD_NOT_START);
    }

    #[test]
    fn the_elevated_half_refuses_to_work_without_administrator_rights() {
        if is_elevated() {
            return; // the test run itself is elevated; nothing to show
        }
        assert_eq!(elevated_run(Path::new("C:\\no\\such\\job.txt"), &new_token().unwrap()), EXIT_NOT_ELEVATED);
    }
}
