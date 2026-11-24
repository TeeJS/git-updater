//! The checks a file must pass before the helper will run it: it looks like the kind of
//! installer the job says it is, its SHA-256 is the one git-updater recorded, and Windows
//! itself says it carries a valid Authenticode signature.

use std::ffi::{c_void, OsStr};
use std::fs;
use std::io::Read;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
use windows_sys::Win32::Security::Cryptography::{
    BCryptCloseAlgorithmProvider, BCryptCreateHash, BCryptDestroyHash, BCryptFinishHash, BCryptHashData, BCryptOpenAlgorithmProvider,
    BCRYPT_SHA256_ALGORITHM,
};
use windows_sys::Win32::Security::WinTrust::{
    WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO, WTD_CHOICE_FILE,
    WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT, WTD_REVOKE_NONE, WTD_REVOKE_WHOLECHAIN, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY,
    WTD_UI_NONE,
};

use crate::job::Kind;
use crate::{EXIT_HASH_MISMATCH, EXIT_NOT_AN_INSTALLER, EXIT_NOT_SIGNED, EXIT_OK};

pub fn wide(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain(std::iter::once(0)).collect()
}

pub fn sha256_of(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    unsafe {
        let mut alg = null_mut();
        if BCryptOpenAlgorithmProvider(&mut alg, BCRYPT_SHA256_ALGORITHM, null(), 0) != 0 {
            return None;
        }
        let mut hash = null_mut();
        if BCryptCreateHash(alg, &mut hash, null_mut(), 0, null(), 0, 0) != 0 {
            BCryptCloseAlgorithmProvider(alg, 0);
            return None;
        }
        let mut buf = vec![0u8; 1024 * 1024];
        let mut ok = true;
        loop {
            match file.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if BCryptHashData(hash, buf.as_ptr(), n as u32, 0) != 0 {
                        ok = false;
                        break;
                    }
                }
                Err(_) => {
                    ok = false;
                    break;
                }
            }
        }
        let mut digest = [0u8; 32];
        if ok && BCryptFinishHash(hash, digest.as_mut_ptr(), 32, 0) != 0 {
            ok = false;
        }
        BCryptDestroyHash(hash);
        BCryptCloseAlgorithmProvider(alg, 0);
        if !ok {
            return None;
        }
        Some(digest.iter().map(|b| format!("{b:02x}")).collect())
    }
}

// Windows' own verdict on the file's embedded Authenticode signature. No window is shown.
fn trust_verdict(path: &Path, check_revocation: bool) -> i32 {
    let wpath = wide(path.as_os_str());
    unsafe {
        let mut file_info: WINTRUST_FILE_INFO = std::mem::zeroed();
        file_info.cbStruct = std::mem::size_of::<WINTRUST_FILE_INFO>() as u32;
        file_info.pcwszFilePath = wpath.as_ptr();
        let mut data: WINTRUST_DATA = std::mem::zeroed();
        data.cbStruct = std::mem::size_of::<WINTRUST_DATA>() as u32;
        data.dwUIChoice = WTD_UI_NONE;
        data.fdwRevocationChecks = if check_revocation { WTD_REVOKE_WHOLECHAIN } else { WTD_REVOKE_NONE };
        if check_revocation {
            data.dwProvFlags = WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT;
        }
        data.dwUnionChoice = WTD_CHOICE_FILE;
        data.Anonymous = WINTRUST_DATA_0 { pFile: &mut file_info };
        data.dwStateAction = WTD_STATEACTION_VERIFY;
        let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
        let verdict = WinVerifyTrust(INVALID_HANDLE_VALUE as _, &mut action, &mut data as *mut _ as *mut c_void);
        data.dwStateAction = WTD_STATEACTION_CLOSE;
        WinVerifyTrust(INVALID_HANDLE_VALUE as _, &mut action, &mut data as *mut _ as *mut c_void);
        verdict
    }
}

// The three answers that mean "the revocation list could not be reached", as opposed to
// "this certificate is revoked".
const CERT_E_REVOCATION_FAILURE: i32 = 0x800B010Eu32 as i32;
const CRYPT_E_NO_REVOCATION_CHECK: i32 = 0x80092012u32 as i32;
const CRYPT_E_REVOCATION_OFFLINE: i32 = 0x80092013u32 as i32;

/// True when the file carries a valid signature that chains to a trusted root and is not
/// revoked. A PC that cannot reach the revocation lists (offline, filtered) still gets a
/// yes for an otherwise valid signature, as Windows does; a certificate known to be revoked
/// is always a no.
pub fn is_signed(path: &Path) -> bool {
    match trust_verdict(path, true) {
        0 => true,
        CERT_E_REVOCATION_FAILURE | CRYPT_E_NO_REVOCATION_CHECK | CRYPT_E_REVOCATION_OFFLINE => trust_verdict(path, false) == 0,
        _ => false,
    }
}

/// The file is named and shaped like the kind of installer the job says it is: `.msi` and a
/// Windows Installer database, or `.exe` and a Windows program. This cannot tell an
/// installer from any other program; it only refuses what is plainly something else.
pub fn looks_like(kind: Kind, path: &Path) -> bool {
    let (extension, magic): (&str, &[u8]) = match kind {
        Kind::Msi => ("msi", &[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        Kind::Exe => ("exe", b"MZ"),
    };
    if !path.extension().is_some_and(|e| e.eq_ignore_ascii_case(extension)) {
        return false;
    }
    let Ok(meta) = fs::symlink_metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    let mut head = [0u8; 8];
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let read = file.read(&mut head).unwrap_or(0);
    head[..read].starts_with(magic)
}

/// 0 when the file passes every check, otherwise the code for the first one it fails.
pub fn check_file(kind: Kind, path: &Path, sha256: &str) -> u32 {
    if !looks_like(kind, path) {
        return EXIT_NOT_AN_INSTALLER;
    }
    if sha256_of(path).as_deref() != Some(sha256) {
        return EXIT_HASH_MISMATCH;
    }
    if !is_signed(path) {
        return EXIT_NOT_SIGNED;
    }
    EXIT_OK
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const MSI_MAGIC: [u8; 8] = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

    fn scratch(name: &str, bytes: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gu-helper-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(name);
        fs::write(&file, bytes).unwrap();
        file
    }

    #[test]
    fn hashes_match_the_published_test_vectors() {
        let empty = scratch("empty.exe", b"");
        assert_eq!(sha256_of(&empty).unwrap(), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        let abc = scratch("abc.exe", b"abc");
        assert_eq!(sha256_of(&abc).unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert!(sha256_of(&abc.with_file_name("missing.exe")).is_none());
    }

    #[test]
    fn refuses_what_is_plainly_not_the_stated_kind() {
        let msi = scratch("real.msi", &MSI_MAGIC);
        let exe = scratch("real.exe", b"MZ\x90\x00");
        assert!(looks_like(Kind::Msi, &msi));
        assert!(looks_like(Kind::Exe, &exe));
        assert!(!looks_like(Kind::Exe, &msi), "an .msi offered as an exe");
        assert!(!looks_like(Kind::Msi, &exe), "an .exe offered as an msi");
        assert!(!looks_like(Kind::Exe, &scratch("script.exe", b"echo hi")), "a script renamed .exe");
        assert!(!looks_like(Kind::Msi, &scratch("zip.msi", b"PK\x03\x04")), "a zip renamed .msi");
        assert!(!looks_like(Kind::Exe, &scratch("run.bat", b"MZ")), "the wrong extension");
        assert!(!looks_like(Kind::Exe, &scratch("run.ps1", b"MZ")), "a script extension");
        assert!(!looks_like(Kind::Exe, exe.parent().unwrap()), "a folder");
        assert!(!looks_like(Kind::Exe, &exe.with_file_name("missing.exe")), "a file that is not there");
    }

    #[test]
    fn checks_run_in_order_and_an_unsigned_file_is_refused() {
        let bytes = [&MSI_MAGIC[..], b" not really an installer"].concat();
        let file = scratch("unsigned.msi", &bytes);
        let sha = sha256_of(&file).unwrap();
        assert_eq!(check_file(Kind::Exe, &file, &sha), EXIT_NOT_AN_INSTALLER);
        assert_eq!(check_file(Kind::Msi, &file, &"0".repeat(64)), EXIT_HASH_MISMATCH);
        assert_eq!(check_file(Kind::Msi, &file, &sha), EXIT_NOT_SIGNED);
        assert!(!is_signed(&file));
    }

    #[test]
    fn a_file_changed_after_its_hash_was_taken_is_refused() {
        let file = scratch("swapped.exe", b"MZ original");
        let sha = sha256_of(&file).unwrap();
        fs::write(&file, b"MZ replaced").unwrap();
        assert_eq!(check_file(Kind::Exe, &file, &sha), EXIT_HASH_MISMATCH);
    }
}
