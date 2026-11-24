//! The job list git-updater hands the helper, and the results the helper hands back.
//!
//! Both are plain text with one field per line, so neither side needs a parser library:
//!
//! ```text
//! git-updater-helper-job 1
//! timeout 600                      (optional: seconds allowed per installer)
//! item
//! file C:\Users\me\AppData\Local\git-updater\staging\app-1.2.3.msi
//! sha256 <64 hex digits>
//! kind msi                         (msi or exe)
//! arg /qn                          (zero or more: one switch per line, passed as written)
//! arg /norestart
//! item
//! file C:\...\setup.exe
//! sha256 <64 hex digits>
//! kind exe
//! raw /Q /C:"msiexec /i ""x.msi"" /quiet"   (instead of arg lines: one verbatim switch string)
//! ```
//!
//! The results are `git-updater-helper-results 1` followed by one `<item number> <code>` line
//! per item, counted from 0. A code is the installer's own exit code, or one of the helper's
//! codes in `main.rs` when the installer was never started.
//!
//! Everything in a job is treated as untrusted: the file that carries it can be written by
//! any program running as the user.

use std::path::{Component, Path, PathBuf, Prefix};

pub const JOB_HEADER: &str = "git-updater-helper-job 1";
pub const RESULTS_HEADER: &str = "git-updater-helper-results 1";
pub const MAX_JOB_BYTES: u64 = 1024 * 1024;
pub const DEFAULT_TIMEOUT_SECS: u64 = 600;
const MAX_TIMEOUT_SECS: u64 = 3600;
const MAX_ITEMS: usize = 64;
const MAX_ARGS: usize = 64;
const MAX_LINE: usize = 8192;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Msi,
    Exe,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Switches {
    Args(Vec<String>),
    Raw(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub file: PathBuf,
    pub sha256: String,
    pub kind: Kind,
    pub switches: Switches,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Job {
    pub timeout_secs: u64,
    pub items: Vec<Item>,
}

#[derive(Default)]
struct Draft {
    file: Option<PathBuf>,
    sha256: Option<String>,
    kind: Option<Kind>,
    args: Vec<String>,
    raw: Option<String>,
}

impl Draft {
    fn finish(self) -> Option<Item> {
        let switches = match self.raw {
            Some(raw) if self.args.is_empty() => Switches::Raw(raw),
            Some(_) => return None, // arg lines and a raw line cannot be mixed
            None => Switches::Args(self.args),
        };
        Some(Item { file: self.file?, sha256: self.sha256?, kind: self.kind?, switches })
    }
}

// A full path on a lettered drive (C:\...). Not a network share, not a device path, and
// with no ".." in it.
fn is_plain_local_path(path: &Path) -> bool {
    let mut parts = path.components();
    let on_drive = matches!(parts.next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_)));
    on_drive
        && matches!(parts.next(), Some(Component::RootDir))
        && path.file_name().is_some()
        && parts.all(|c| matches!(c, Component::Normal(_)))
}

fn clean(value: &str) -> bool {
    !value.chars().any(|c| c.is_control())
}

/// The job, or `None` when anything at all about the text is not as specified.
pub fn parse_job(text: &str) -> Option<Job> {
    let mut lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    if lines.iter().any(|l| l.len() > MAX_LINE) {
        return None;
    }
    let mut lines = lines.into_iter().peekable();
    if lines.next()? != JOB_HEADER {
        return None;
    }
    let mut timeout_secs = DEFAULT_TIMEOUT_SECS;
    if let Some(value) = lines.peek().and_then(|l| l.strip_prefix("timeout ")) {
        timeout_secs = value.parse().ok().filter(|t| (1..=MAX_TIMEOUT_SECS).contains(t))?;
        lines.next();
    }
    let mut items = Vec::new();
    let mut draft: Option<Draft> = None;
    for line in lines {
        if line == "item" {
            if let Some(done) = draft.take() {
                items.push(done.finish()?);
            }
            if items.len() >= MAX_ITEMS {
                return None;
            }
            draft = Some(Draft::default());
            continue;
        }
        let current = draft.as_mut()?;
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        if !clean(value) {
            return None;
        }
        match key {
            "file" if current.file.is_none() => {
                let path = PathBuf::from(value);
                if !is_plain_local_path(&path) {
                    return None;
                }
                current.file = Some(path);
            }
            "sha256" if current.sha256.is_none() => {
                if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return None;
                }
                current.sha256 = Some(value.to_ascii_lowercase());
            }
            "kind" if current.kind.is_none() => {
                current.kind = Some(match value {
                    "msi" => Kind::Msi,
                    "exe" => Kind::Exe,
                    _ => return None,
                });
            }
            "arg" if current.raw.is_none() && current.args.len() < MAX_ARGS => current.args.push(value.to_string()),
            "raw" if current.raw.is_none() && current.args.is_empty() && !value.trim().is_empty() => {
                current.raw = Some(value.to_string());
            }
            _ => return None,
        }
    }
    items.push(draft?.finish()?);
    Some(Job { timeout_secs, items })
}

pub fn format_results(results: &[(usize, u32)]) -> String {
    let mut out = String::from(RESULTS_HEADER);
    out.push('\n');
    for (index, code) in results {
        out.push_str(&format!("{index} {code}\n"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    fn job(body: &str) -> Option<Job> {
        parse_job(&format!("{JOB_HEADER}\n{body}"))
    }

    fn one(extra: &str) -> Option<Job> {
        job(&format!("item\nfile C:\\stage\\app.msi\nsha256 {SHA}\nkind msi\n{extra}"))
    }

    #[test]
    fn reads_a_job_with_both_switch_forms() {
        let parsed = job(&format!(
            "timeout 90\nitem\nfile C:\\stage\\app.msi\nsha256 {}\nkind msi\narg /qn\narg /norestart\nitem\nfile D:\\x y\\setup.exe\nsha256 {SHA}\nkind exe\nraw /Q /C:\"msiexec /i \"\"x.msi\"\" /quiet\"\n",
            SHA.to_ascii_uppercase()
        ))
        .unwrap();
        assert_eq!(parsed.timeout_secs, 90);
        assert_eq!(parsed.items.len(), 2);
        assert_eq!(parsed.items[0].kind, Kind::Msi);
        assert_eq!(parsed.items[0].sha256, SHA, "the hash is compared in lower case");
        assert_eq!(parsed.items[0].switches, Switches::Args(vec!["/qn".into(), "/norestart".into()]));
        assert_eq!(parsed.items[1].file, PathBuf::from("D:\\x y\\setup.exe"));
        assert_eq!(parsed.items[1].switches, Switches::Raw("/Q /C:\"msiexec /i \"\"x.msi\"\" /quiet\"".into()));
    }

    #[test]
    fn defaults_and_line_endings() {
        let parsed = parse_job(&format!("{JOB_HEADER}\r\nitem\r\nfile C:\\a\\b.exe\r\nsha256 {SHA}\r\nkind exe\r\narg\r\narg  /S \r\n")).unwrap();
        assert_eq!(parsed.timeout_secs, DEFAULT_TIMEOUT_SECS);
        // An empty switch and a switch with its own spaces both arrive exactly as written.
        assert_eq!(parsed.items[0].switches, Switches::Args(vec!["".into(), " /S ".into()]));
        assert_eq!(one("").unwrap().items[0].switches, Switches::Args(vec![]));
    }

    #[test]
    fn refuses_anything_not_as_specified() {
        assert!(parse_job("").is_none());
        assert!(parse_job("git-updater-helper-job 2\nitem\n").is_none(), "another version");
        assert!(job("").is_none(), "no items");
        assert!(job("item\n").is_none(), "an empty item");
        assert!(job(&format!("file C:\\a.msi\nsha256 {SHA}\nkind msi\n")).is_none(), "fields before any item");
        assert!(one("kind msi\n").is_none(), "a field twice");
        assert!(one("colour blue\n").is_none(), "an unknown field");
        assert!(one("arg /qn\nraw /qn\n").is_none(), "both switch forms");
        assert!(one("raw /qn\narg /qn\n").is_none(), "both switch forms, other order");
        assert!(one("raw  \n").is_none(), "an empty verbatim string");
        assert!(one("arg a\u{7}b\n").is_none(), "a control character");
        assert!(job(&format!("item\nfile C:\\a.msi\nsha256 {SHA}\nkind zip\n")).is_none(), "an unknown kind");
        assert!(job(&format!("item\nfile C:\\a.msi\nsha256 abc\nkind msi\n")).is_none(), "a short hash");
        assert!(job(&format!("item\nsha256 {SHA}\nkind msi\n")).is_none(), "no file");
        assert!(job(&format!("timeout 0\nitem\nfile C:\\a.msi\nsha256 {SHA}\nkind msi\n")).is_none(), "no time at all");
        assert!(job(&format!("timeout 99999\nitem\nfile C:\\a.msi\nsha256 {SHA}\nkind msi\n")).is_none(), "too long a limit");
    }

    #[test]
    fn refuses_paths_that_are_not_a_plain_file_on_a_drive() {
        for bad in ["app.msi", "\\stage\\app.msi", "C:app.msi", "\\\\server\\share\\app.msi", "\\\\?\\C:\\stage\\app.msi", "C:\\stage\\..\\app.msi", "C:\\"] {
            let text = format!("item\nfile {bad}\nsha256 {SHA}\nkind msi\n");
            assert!(job(&text).is_none(), "{bad}");
        }
        assert!(is_plain_local_path(Path::new("C:\\stage\\app.msi")));
        assert!(!is_plain_local_path(Path::new("C:\\stage\\..\\app.msi")));
    }

    #[test]
    fn refuses_a_job_that_is_too_big() {
        let many: String = (0..65).map(|_| format!("item\nfile C:\\a.msi\nsha256 {SHA}\nkind msi\n")).collect();
        assert!(job(&many).is_none(), "65 items");
        let args: String = (0..65).map(|_| "arg /x\n").collect();
        assert!(one(&args).is_none(), "65 switches");
        assert!(one(&format!("arg {}\n", "x".repeat(9000))).is_none(), "a very long line");
    }

    #[test]
    fn results_are_one_line_per_item() {
        assert_eq!(format_results(&[(0, 0), (1, 3010), (2, 64007)]), "git-updater-helper-results 1\n0 0\n1 3010\n2 64007\n");
    }
}
