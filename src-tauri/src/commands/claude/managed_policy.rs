//! Read local managed constraints without executing policy helpers or exposing values.

use super::settings_store;
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Default)]
pub struct ManagedConstraints {
    pub memory_directory: bool,
    pub compaction_percent: bool,
    pub effort_level: bool,
}

fn add(constraints: &mut ManagedConstraints, value: &Value) {
    constraints.memory_directory |= value.get("autoMemoryDirectory").is_some();
    constraints.compaction_percent |= value.pointer("/env/CLAUDE_AUTOCOMPACT_PCT_OVERRIDE").is_some();
    constraints.effort_level |= value.get("effortLevel").is_some()
        || value.pointer("/env/CLAUDE_CODE_EFFORT_LEVEL").is_some()
        || value.pointer("/env/CLAUDE_CODE_THINKING_EFFORT").is_some();
}

fn inspect_files(directory: &Path, constraints: &mut ManagedConstraints) -> Result<(), String> {
    let primary = directory.join("managed-settings.json");
    if primary.exists() {
        add(constraints, &settings_store::read(&primary)?);
    }
    let dropins = directory.join("managed-settings.d");
    if dropins.exists() {
        let mut files = std::fs::read_dir(dropins)
            .map_err(|_| "Cannot inspect Claude managed settings drop-ins")?
            .map(|entry| entry.map(|entry| entry.path())).collect::<Result<Vec<_>, _>>()
            .map_err(|_| "Cannot inspect Claude managed settings drop-ins")?;
        files.sort();
        for file in files.into_iter().filter(|path| path.extension().is_some_and(|value| value == "json")) {
            if file.is_file() { add(constraints, &settings_store::read(&file)?); }
        }
    }
    Ok(())
}

pub fn constraints() -> Result<ManagedConstraints, String> {
    let mut constraints = ManagedConstraints::default();
    #[cfg(windows)]
    {
        let directory = std::env::var_os("ProgramFiles").map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Program Files")).join("ClaudeCode");
        inspect_files(&directory, &mut constraints)?;
        for root in [0x8000_0001u32, 0x8000_0002u32] {
            if let Some(value) = registry_settings(root)? { add(&mut constraints, &value); }
        }
    }
    #[cfg(target_os = "macos")]
    inspect_files(Path::new("/Library/Application Support/ClaudeCode"), &mut constraints)?;
    #[cfg(all(unix, not(target_os = "macos")))]
    inspect_files(Path::new("/etc/claude-code"), &mut constraints)?;
    Ok(constraints)
}

#[cfg(windows)]
fn registry_settings(root: u32) -> Result<Option<Value>, String> {
    type Hkey = isize;
    #[link(name = "advapi32")]
    extern "system" {
        fn RegOpenKeyExW(root: Hkey, path: *const u16, options: u32, access: u32, key: *mut Hkey) -> i32;
        fn RegQueryValueExW(key: Hkey, name: *const u16, reserved: *mut u32, kind: *mut u32, data: *mut u8, size: *mut u32) -> i32;
        fn RegCloseKey(key: Hkey) -> i32;
    }
    struct OpenKey(Hkey);
    impl Drop for OpenKey {
        fn drop(&mut self) { unsafe { RegCloseKey(self.0); } }
    }
    let wide = |value: &str| value.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let path = wide(r"SOFTWARE\Policies\ClaudeCode");
    let name = wide("Settings");
    let mut key = 0;
    let status = unsafe { RegOpenKeyExW(root as i32 as Hkey, path.as_ptr(), 0, 1 | 0x100, &mut key) };
    if status == 2 || status == 3 { return Ok(None); }
    if status != 0 { return Err("Cannot inspect Claude managed registry settings".into()); }
    let key = OpenKey(key);
    let (mut kind, mut size) = (0, 0);
    let status = unsafe { RegQueryValueExW(key.0, name.as_ptr(), std::ptr::null_mut(), &mut kind, std::ptr::null_mut(), &mut size) };
    if status == 2 { return Ok(None); }
    if status != 0 || !matches!(kind, 1 | 2) || size > 4 * 1024 * 1024 || size % 2 != 0 {
        return Err("Claude managed registry settings have an invalid type or exceed the read budget".into());
    }
    let mut bytes = vec![0u8; size as usize];
    let status = unsafe { RegQueryValueExW(key.0, name.as_ptr(), std::ptr::null_mut(), &mut kind, bytes.as_mut_ptr(), &mut size) };
    if status != 0 || size as usize > bytes.len() || size % 2 != 0 {
        return Err("Claude managed registry settings changed while being read".into());
    }
    let mut units = bytes[..size as usize].chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect::<Vec<_>>();
    while units.last() == Some(&0) { units.pop(); }
    let json = String::from_utf16(&units).map_err(|_| "Claude managed registry settings are not valid text")?;
    settings_store::parse(json.as_bytes()).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn managed_directory_and_percent_are_detected_without_guessing_other_fields() {
        let mut result = ManagedConstraints::default();
        add(&mut result, &json!({"env": {"ANTHROPIC_AUTH_TOKEN": "fixture"}, "permissions": {}}));
        assert!(!result.memory_directory && !result.compaction_percent);
        add(&mut result, &json!({"autoMemoryDirectory": "D:/managed-memory"}));
        add(&mut result, &json!({"env": {"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "70"}}));
        assert!(result.memory_directory && result.compaction_percent);
    }

    #[test]
    fn managed_effort_sources_prevent_per_session_overrides() {
        for setting in [json!({"effortLevel": "high"}),
                        json!({"env": {"CLAUDE_CODE_EFFORT_LEVEL": "high"}}),
                        json!({"env": {"CLAUDE_CODE_THINKING_EFFORT": "high"}})] {
            let mut result = ManagedConstraints::default();
            add(&mut result, &setting);
            assert!(result.effort_level);
            assert!(!result.memory_directory && !result.compaction_percent);
        }
    }
}
