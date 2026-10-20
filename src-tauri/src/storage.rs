//! The app's disposable local data. Simulated replays are not stored: the player
//! keeps them in memory. Original replays, drafts and browser settings are never
//! removed.
use std::{
    fs::{self, File},
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};

// WebView2's disposable caches (HTTP, shader, code) are trimmed to this size.
const BROWSER_CACHE_LIMIT: u64 = 50_000_000;
// Earlier versions kept simulations on disk: uncompressed, then packed.
const SIMULATION_CACHES: [(&str, &str); 2] = [("repsim-v1", "repsim"), ("repsim-v2", "rps2")];

pub struct AppStorage {
    root: PathBuf,
    _lock: File,
}

// Never follow links out of the app-owned directory.
fn files(root: &Path, result: &mut Vec<(PathBuf, u64, SystemTime)>) {
    if fs::symlink_metadata(root).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            files(&entry.path(), result);
        } else if kind.is_file() {
            // Windows directory enumeration can report an old size while a
            // conversion's file handle is open. Query the file handle itself.
            if let Ok(metadata) = File::open(entry.path())
                .and_then(|f| f.metadata())
                .or_else(|_| entry.metadata())
            {
                result.push((
                    entry.path(),
                    metadata.len(),
                    metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                ));
            }
        }
    }
}
fn trim_browser_caches(root: &Path, limit: u64) {
    let browser = root.join("EBWebView");
    let mut entries = Vec::new();
    files(&browser, &mut entries);
    let mut bytes: u64 = entries.iter().map(|(_, size, _)| size).sum();
    if bytes <= limit {
        return;
    }
    entries.sort_by_key(|(_, _, modified)| *modified);
    for (path, size, _) in entries {
        let disposable = path.strip_prefix(&browser).is_ok_and(|relative| {
            relative.components().any(|part| {
                matches!(
                    part.as_os_str().to_str(),
                    Some(
                        "Cache"
                            | "Code Cache"
                            | "GPUCache"
                            | "GPUPersistentCache"
                            | "ShaderCache"
                            | "GrShaderCache"
                            | "component_crx_cache"
                            | "extensions_crx_cache"
                    )
                )
            })
        });
        // Never remove preferences, Local Storage, cookies, IndexedDB or runtime
        // components. Locked browser cache files are retried on the next sweep.
        if disposable && fs::remove_file(&path).is_ok() {
            bytes = bytes.saturating_sub(size);
        }
        if bytes <= limit {
            break;
        }
    }
}
/// Deletes the simulations earlier versions cached. Other files stay.
fn remove_simulations(root: &Path) {
    for (folder, extension) in SIMULATION_CACHES {
        let folder = root.join(folder);
        let mut entries = Vec::new();
        files(&folder, &mut entries);
        for (path, _, _) in entries {
            if path.extension().is_some_and(|x| x == extension) {
                let _ = fs::remove_file(path);
            }
        }
        // Only an empty folder is removed.
        let _ = fs::remove_dir(folder);
    }
}
impl AppStorage {
    pub fn new(root: PathBuf) -> Result<Arc<Self>, String> {
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join(".storage-budget.lock"))
            .map_err(|e| e.to_string())?;
        lock.try_lock().map_err(|_| {
            "More of Dots is already running. Close its other instance first.".to_string()
        })?;
        remove_simulations(&root);
        let storage = Arc::new(Self {
            root,
            _lock: lock,
        });
        storage.maintain();
        Ok(storage)
    }
    pub fn maintain(&self) {
        trim_browser_caches(&self.root, BROWSER_CACHE_LIMIT);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn startup_deletes_cached_simulations_but_keeps_originals() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("repsim-v1");
        let packed = dir.path().join("repsim-v2");
        fs::create_dir(&old).unwrap();
        fs::create_dir(&packed).unwrap();
        fs::write(old.join("old.repsim"), [0; 32]).unwrap();
        fs::write(old.join("original.rep"), [0; 12]).unwrap();
        fs::write(packed.join("saved.rps2"), [0; 16]).unwrap();
        fs::write(packed.join(".tmpxyz.rps2"), [0; 16]).unwrap();
        let _storage = AppStorage::new(dir.path().into()).unwrap();
        assert!(!old.join("old.repsim").exists());
        assert!(old.join("original.rep").exists());
        assert!(!packed.exists());
    }
    #[test]
    fn another_process_cannot_open_the_same_storage() {
        let dir = tempfile::tempdir().unwrap();
        let first = AppStorage::new(dir.path().into()).unwrap();
        assert!(AppStorage::new(dir.path().into()).is_err());
        drop(first);
        assert!(AppStorage::new(dir.path().into()).is_ok());
    }
    #[test]
    fn browser_cleanup_preserves_saved_settings_and_components() {
        let dir = tempfile::tempdir().unwrap();
        let browser = dir.path().join("EBWebView");
        for name in [
            "Default/Cache",
            "Default/Local Storage",
            "CertificateRevocation",
        ] {
            fs::create_dir_all(browser.join(name)).unwrap();
            fs::write(browser.join(name).join("data"), [0; 30]).unwrap();
        }
        trim_browser_caches(dir.path(), 60);
        assert!(!browser.join("Default/Cache/data").exists());
        assert!(browser.join("Default/Local Storage/data").exists());
        assert!(browser.join("CertificateRevocation/data").exists());
    }
}
