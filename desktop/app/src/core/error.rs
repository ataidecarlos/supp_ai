use std::fmt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
}

impl Error {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Error { code, message: message.into() }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

/// Write bytes to a temporary file in the same directory, then rename over the target.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| Error::new("IO", format!("{} has no parent directory", path.display())))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| Error::new("IO", format!("Cannot create {}: {error}", parent.display())))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let temporary: PathBuf = parent.join(format!(
        ".{}.{}.{}.tmp",
        path.file_name().and_then(|name| name.to_str()).unwrap_or("write"),
        std::process::id(),
        stamp
    ));
    std::fs::write(&temporary, bytes)
        .map_err(|error| Error::new("IO", format!("Cannot write {}: {error}", temporary.display())))?;
    std::fs::rename(&temporary, path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        Error::new("IO", format!("Cannot replace {}: {error}", path.display()))
    })
}
