// Embeds the manifest (asInvoker) and the version information into the helper.
use std::{env, fs, path::PathBuf, process::Command};

fn find_rc() -> Option<PathBuf> {
    if let Ok(rc) = env::var("RC") {
        return Some(PathBuf::from(rc));
    }
    let base = PathBuf::from(r"C:\Program Files (x86)\Windows Kits\10\bin");
    let mut versions: Vec<PathBuf> = fs::read_dir(&base)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("10.")))
        .collect();
    versions.sort();
    versions.into_iter().rev().map(|v| v.join("x64").join("rc.exe")).find(|p| p.exists())
}

fn main() {
    println!("cargo:rerun-if-changed=helper.manifest");
    println!("cargo:rerun-if-changed=helper.rc");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") || env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc") {
        return;
    }
    let dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    println!("cargo:rustc-link-arg-bins=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg-bins=/MANIFESTINPUT:{}", dir.join("helper.manifest").display());
    println!("cargo:rustc-link-arg-bins=/MANIFESTUAC:NO");
    // Resolve the Windows libraries this program links to from System32 only, never from the
    // folder the program sits in (which the user account may be able to write to).
    println!("cargo:rustc-link-arg-bins=/DEPENDENTLOADFLAG:0x800");
    let Some(rc) = find_rc() else {
        println!("cargo:warning=rc.exe not found: the helper is built without version information");
        return;
    };
    let res = out.join("helper.res");
    let status = Command::new(&rc)
        .arg("/nologo")
        .arg("/fo")
        .arg(&res)
        .arg(dir.join("helper.rc"))
        .status()
        .expect("could not run rc.exe");
    assert!(status.success(), "rc.exe failed");
    println!("cargo:rustc-link-arg-bins={}", res.display());
}
