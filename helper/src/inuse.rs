// Which programs have files under a folder open: `--who-uses --folder <dir>`.
//
// Not elevated. Runs nothing, writes nothing, changes nothing. git-updater asks this after an
// installer fails, so the row can name what to close. OBS's installer failed (exit 6) while OBS
// itself was closed: Chrome and the Claude app had OBS's virtual-camera file loaded, so "if the
// app is open, close it" pointed at the wrong thing.
//
// The answer comes from Windows' Restart Manager: the same list an installer's own "close these
// apps" page shows, with each program's own name ("Google Chrome").

use std::fs;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS};
use windows_sys::Win32::System::RestartManager::{
    RmEndSession, RmGetList, RmRegisterResources, RmStartSession, CCH_RM_SESSION_KEY, RM_PROCESS_INFO,
};

// Only the files a program holds open by running or loading them, which are the ones an
// installer most often cannot replace. Capped, so a huge folder cannot keep the row waiting.
const KINDS: [&str; 7] = ["exe", "dll", "ax", "ocx", "node", "sys", "cpl"];
pub const MAX_FILES: usize = 20_000;
const MAX_DEPTH: usize = 12;
const BATCH: usize = 500;

pub struct User {
    pub pid: u32,
    pub name: String,
}

// Every program-like file under `dir`. A link to another folder is not followed: it is not
// part of the app.
pub fn files_under(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![(dir.to_path_buf(), 0usize)];
    while let Some((folder, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&folder) else { continue };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let file = entry.path();
            if kind.is_dir() {
                if depth < MAX_DEPTH {
                    stack.push((file, depth + 1));
                }
            } else if kind.is_file() && is_program_file(&file) {
                out.push(file);
                if out.len() >= MAX_FILES {
                    return out;
                }
            }
        }
    }
    out
}

fn is_program_file(file: &Path) -> bool {
    file.extension()
        .and_then(|e| e.to_str())
        .map(|e| KINDS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

// A program's name as one line of plain text.
fn clean(name: &[u16]) -> String {
    let len = name.iter().position(|&c| c == 0).unwrap_or(name.len());
    String::from_utf16_lossy(&name[..len])
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_string()
}

fn register(session: u32, files: &[PathBuf]) -> bool {
    for chunk in files.chunks(BATCH) {
        let wide: Vec<Vec<u16>> = chunk.iter().map(|p| p.as_os_str().encode_wide().chain(Some(0)).collect()).collect();
        let names: Vec<*const u16> = wide.iter().map(|w| w.as_ptr()).collect();
        if unsafe { RmRegisterResources(session, names.len() as u32, names.as_ptr(), 0, null(), 0, null()) } != ERROR_SUCCESS {
            return false;
        }
    }
    true
}

fn list(session: u32) -> Option<Vec<RM_PROCESS_INFO>> {
    let mut found: Vec<RM_PROCESS_INFO> = Vec::new();
    // The list can grow between the call that sizes it and the call that fills it: retry.
    for _ in 0..4 {
        let mut needed = 0u32;
        let mut count = found.len() as u32;
        let mut reasons = 0u32;
        let into = if found.is_empty() { null_mut() } else { found.as_mut_ptr() };
        let rc = unsafe { RmGetList(session, &mut needed, &mut count, into, &mut reasons) };
        if rc == ERROR_SUCCESS {
            found.truncate(count as usize);
            return Some(found);
        }
        if rc != ERROR_MORE_DATA {
            return None;
        }
        found = vec![RM_PROCESS_INFO::default(); needed as usize + 4];
    }
    None
}

// The programs that have any of `files` open. None when Windows could not say.
pub fn users_of(files: &[PathBuf]) -> Option<Vec<User>> {
    let mut session = 0u32;
    let mut key = [0u16; CCH_RM_SESSION_KEY as usize + 1];
    if unsafe { RmStartSession(&mut session, 0, key.as_mut_ptr()) } != ERROR_SUCCESS {
        return None;
    }
    let found = if register(session, files) { list(session) } else { None };
    unsafe { RmEndSession(session) };
    found.map(|all| all.iter().map(|p| User { pid: p.Process.dwProcessId, name: clean(&p.strAppName) }).collect())
}

// What `--who-uses` prints: one line per program, its process id and its name, tab-separated.
pub fn format_users(users: &[User]) -> String {
    users.iter().map(|u| format!("{}\t{}\n", u.pid, u.name)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gu-helper-inuse-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn only_program_files_are_asked_about_at_any_depth() {
        let dir = scratch("kinds");
        fs::create_dir_all(dir.join("data").join("obs-plugins").join("win-dshow")).unwrap();
        fs::write(dir.join("uninstall.exe"), b"x").unwrap();
        fs::write(dir.join("data").join("obs-plugins").join("win-dshow").join("obs-virtualcam-module64.DLL"), b"x").unwrap();
        fs::write(dir.join("readme.txt"), b"x").unwrap();
        fs::write(dir.join("data").join("locale.ini"), b"x").unwrap();
        let mut names: Vec<String> = files_under(&dir).iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, vec!["obs-virtualcam-module64.DLL", "uninstall.exe"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_program_holding_a_file_open_is_named() {
        let dir = scratch("held");
        let file = dir.join("held.dll");
        fs::write(&file, b"x").unwrap();
        let _open = fs::File::open(&file).unwrap(); // this test process now has it open
        let users = users_of(&files_under(&dir)).expect("Windows answered");
        assert!(users.iter().any(|u| u.pid == std::process::id()), "this process holds the file");
        assert!(users.iter().all(|u| !u.name.contains('\t') && !u.name.contains('\n')));
        drop(_open);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_open_means_nobody_is_named() {
        let dir = scratch("free");
        fs::write(dir.join("free.dll"), b"x").unwrap();
        let users = users_of(&files_under(&dir)).expect("Windows answered");
        assert!(users.iter().all(|u| u.pid != std::process::id()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn names_print_one_per_line() {
        let users = vec![User { pid: 28992, name: "Google Chrome".into() }, User { pid: 10940, name: "Claude".into() }];
        assert_eq!(format_users(&users), "28992\tGoogle Chrome\n10940\tClaude\n");
        let bad: Vec<u16> = "Evil\tName\nX".encode_utf16().chain([0, 65]).collect();
        assert_eq!(clean(&bad), "Evil Name X");
    }
}
