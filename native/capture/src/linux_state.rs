//! Per-user portal grants. A restore token is consumed before any attempt, so a
//! failed/aborted restore cannot reopen the chooser repeatedly on background ticks.
use serde::{Deserialize, Serialize};
use std::{io::Write, os::unix::fs::PermissionsExt, path::PathBuf};
#[derive(Serialize, Deserialize)]
pub struct Grant {
    pub token: String,
    pub context: bool,
}
fn directory() -> Option<PathBuf> {
    std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".local/state")))
        .map(|p| p.join("Breadcrumb"))
}
pub fn take() -> Option<Grant> {
    let path = directory()?.join("screen-sharing.json");
    let metadata = std::fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > 8192 || metadata.permissions().mode() & 0o077 != 0 {
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    std::fs::remove_file(&path).ok()?;
    serde_json::from_slice(&bytes).ok()
}
pub fn save(grant: &Grant) -> Result<(), String> {
    if grant.token.len() > 4096 {
        return Err("Portal restore token exceeds size limit".into());
    }
    let directory = directory().ok_or("No per-user state directory")?;
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(&directory).map_err(|e| e.to_string())?;
    temporary
        .write_all(&serde_json::to_vec(grant).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    temporary
        .persist(directory.join("screen-sharing.json"))
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn forget() {
    if let Some(path) = directory() {
        let _ = std::fs::remove_file(path.join("screen-sharing.json"));
    }
}
