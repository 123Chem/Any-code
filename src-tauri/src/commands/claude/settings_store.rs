//! Strict, field-aware settings updates with preserved originals and no secret logging.

use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;
use super::file_access::FileAccess;

const MAX_SETTINGS_BYTES: u64 = 4 * 1024 * 1024;
static WRITE_LOCK: Mutex<()> = Mutex::new(());

struct UniqueJson(Value);

impl<'de> Deserialize<'de> for UniqueJson {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct JsonVisitor;
        impl<'de> Visitor<'de> for JsonVisitor {
            type Value = UniqueJson;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("valid JSON without duplicate object keys")
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::Null))
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::Bool(v)))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::Number(v.into())))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::Number(v.into())))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
                Number::from_f64(v).map(|n| UniqueJson(Value::Number(n)))
                    .ok_or_else(|| E::custom("non-finite JSON number"))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::String(v.to_owned())))
            }
            fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::String(v)))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = seq.next_element::<UniqueJson>()? {
                    values.push(value.0);
                }
                Ok(UniqueJson(Value::Array(values)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut values = Map::new();
                while let Some(key) = map.next_key::<String>()? {
                    if values.contains_key(&key) {
                        return Err(de::Error::custom("duplicate JSON object key"));
                    }
                    values.insert(key, map.next_value::<UniqueJson>()?.0);
                }
                Ok(UniqueJson(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(JsonVisitor)
    }
}

pub fn parse(content: &[u8]) -> Result<Value, String> {
    let content = content.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(content);
    let data = serde_json::from_slice::<UniqueJson>(content).map_err(|error| {
        format!("Claude settings JSON is invalid at line {}, column {}; check duplicate keys and syntax",
                error.line(), error.column())
    })?.0;
    validate(&data, false)?;
    Ok(data)
}

fn validate(data: &Value, patch: bool) -> Result<(), String> {
    if !data.is_object() {
        return Err("Claude settings must be a JSON object".into());
    }
    if let Some(env) = data.get("env") {
        let env = env.as_object().ok_or("Claude settings env must be an object")?;
        for (key, value) in env {
            if key.trim().is_empty() || key.contains(['\0', '=']) {
                return Err("Claude settings contains an invalid environment variable name".into());
            }
            if !(value.is_string() || (patch && value.is_null())) {
                return Err(format!("Claude settings env.{key} must be a string"));
            }
            if value.as_str().is_some_and(|value| value.contains('\0')) {
                return Err(format!("Claude settings env.{key} contains an invalid character"));
            }
        }
    }
    Ok(())
}

fn read_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot read Claude settings: {error}")),
    };
    let mut bytes = Vec::new();
    file.take(MAX_SETTINGS_BYTES + 1).read_to_end(&mut bytes)
        .map_err(|error| format!("Cannot read Claude settings: {error}"))?;
    if bytes.len() as u64 > MAX_SETTINGS_BYTES {
        return Err("Claude settings exceeds the 4 MiB read budget".into());
    }
    Ok(Some(bytes))
}

pub fn read(path: &Path) -> Result<Value, String> {
    read_bytes(path)?.map(|bytes| parse(&bytes)).unwrap_or_else(|| Ok(serde_json::json!({})))
}

fn patch_object(current: &mut Value, patch: &Value, in_env: bool) {
    if let (Some(target), Some(values)) = (current.as_object_mut(), patch.as_object()) {
        for (key, value) in values {
            if in_env && value.is_null() {
                target.remove(key);
            } else if value.is_object() {
                let entry = target.entry(key.clone()).or_insert_with(|| serde_json::json!({}));
                if !entry.is_object() {
                    *entry = serde_json::json!({});
                }
                patch_object(entry, value, key == "env");
            } else {
                target.insert(key.clone(), value.clone());
            }
        }
    }
}

fn merge_changed(current: &mut Value, desired: &Value, base: &Value, path: &str) -> Result<(), String> {
    if desired == base {
        return Ok(());
    }
    if let (Some(target), Some(wanted), Some(original)) =
        (current.as_object_mut(), desired.as_object(), base.as_object()) {
        let keys: BTreeSet<_> = wanted.keys().chain(original.keys()).cloned().collect();
        for key in keys {
            let before = original.get(&key);
            let after = wanted.get(&key);
            if before == after {
                continue;
            }
            let field = if path.is_empty() { key.clone() } else { format!("{path}.{key}") };
            match (before, after) {
                (Some(before), Some(after)) if before.is_object() && after.is_object() => {
                    let entry = target.entry(key).or_insert(Value::Null);
                    merge_changed(entry, after, before, &field)?;
                }
                _ => {
                    if target.get(&key) != before && target.get(&key) != after {
                        return Err(format!("Claude settings field {field} changed outside this settings page; reload before saving"));
                    }
                    if let Some(value) = after {
                        target.insert(key, value.clone());
                    } else {
                        target.remove(&key);
                    }
                }
            }
        }
        Ok(())
    } else if current == base || current == desired {
        *current = desired.clone();
        Ok(())
    } else {
        Err(format!("Claude settings field {path} changed outside this settings page; reload before saving"))
    }
}

pub fn merged(current: &Value, desired: &Value, baseline: Option<&Value>) -> Result<Value, String> {
    validate(current, false)?;
    validate(desired, baseline.is_none())?;
    let mut result = current.clone();
    if let Some(base) = baseline {
        validate(base, false)?;
        merge_changed(&mut result, desired, base, "")?;
    } else {
        patch_object(&mut result, desired, false);
    }
    validate(&result, false)?;
    Ok(result)
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path, existed: bool) -> Result<(), String> {
    if !existed {
        return fs::rename(source, target).map_err(|error| format!("Cannot publish Claude settings: {error}"));
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn ReplaceFileW(target: *const u16, source: *const u16, backup: *const u16,
                        flags: u32, exclude: *const std::ffi::c_void, reserved: *const std::ffi::c_void) -> i32;
    }
    let target = super::file_access::windows_security_path(target)?;
    let source = super::file_access::windows_security_path(source)?;
    let okay = unsafe { ReplaceFileW(target.as_ptr(), source.as_ptr(), std::ptr::null(), 0,
                                     std::ptr::null(), std::ptr::null()) };
    if okay == 0 {
        return Err(format!("Cannot atomically publish Claude settings; original and staged file retained: {}",
                           std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path, _existed: bool) -> Result<(), String> {
    fs::rename(source, target).map_err(|error| format!("Cannot publish Claude settings: {error}"))
}

pub fn update(path: &Path, desired: &Value, baseline: Option<&Value>) -> Result<Value, String> {
    let _lock = WRITE_LOCK.lock().map_err(|_| "Claude settings writer unavailable")?;
    validate(desired, true)?;
    let parent = path.parent().ok_or("Claude settings path has no parent")?;
    fs::create_dir_all(parent).map_err(|error| format!("Cannot prepare Claude settings directory: {error}"))?;
    let _shared_writer = shared_writer(parent)?;
    let original = read_bytes(path)?;
    let current = original.as_ref().map(|bytes| parse(bytes)).unwrap_or_else(|| Ok(serde_json::json!({})))?;
    let result = merged(&current, desired, baseline)?;
    if result == current {
        return Ok(result);
    }
    let access = original.as_ref().map(|_| FileAccess::capture(path)).transpose()?;
    if let Some(bytes) = &original {
        let digest = format!("{:x}", Sha256::digest(bytes));
        let backup = parent.join(format!("settings.before-anycode-repair-{digest}.json"));
        match OpenOptions::new().write(true).create_new(true).open(&backup) {
            Ok(mut file) => {
                if let Some(access) = &access { access.apply(&backup)?; }
                file.write_all(bytes).and_then(|_| file.sync_all())
                    .map_err(|error| format!("Cannot preserve original Claude settings: {error}"))?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if read_bytes(&backup)?.as_ref() != Some(bytes) {
                    return Err("Claude settings backup does not match the original".into());
                }
                if let Some(access) = &access { access.apply(&backup)?; }
            }
            Err(error) => return Err(format!("Cannot preserve original Claude settings: {error}")),
        }
    }
    let staged = parent.join(format!(".settings-anycode-{}.tmp", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new().write(true).create_new(true).open(&staged)
        .map_err(|error| format!("Cannot stage Claude settings: {error}"))?;
    if let Some(access) = &access { access.apply(&staged)?; }
    let bytes = serde_json::to_vec_pretty(&result).map_err(|_| "Cannot encode Claude settings")?;
    file.write_all(&bytes).and_then(|_| file.sync_all())
        .map_err(|error| format!("Cannot stage Claude settings: {error}"))?;
    drop(file);
    if read_bytes(path)? != original {
        return Err("Claude settings changed while saving; original and staged file retained, reload before saving".into());
    }
    replace_file(&staged, path, original.is_some())?;
    if let Some(access) = &access { access.apply(path)?; }
    Ok(result)
}

fn shared_writer(directory: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    let file = options.open(directory.join("codex-settings-write.lock"))
        .map_err(|_| "Claude settings are being saved by another client, or the directory is not writable; original file was not overwritten")?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        extern "C" { fn flock(fd: std::ffi::c_int, operation: std::ffi::c_int) -> std::ffi::c_int; }
        if unsafe { flock(file.as_raw_fd(), 2 | 4) } != 0 {
            return Err("Claude settings are being saved by another client; original file was not overwritten".into());
        }
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn partial_env_preserves_credentials_and_unknown_fields() {
        let current = json!({"env":{"ANTHROPIC_AUTH_TOKEN":"secret","X":"keep"},"hooks":{"Stop":[]}});
        let result = merged(&current, &json!({"env":{"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE":"60"}}), None).unwrap();
        assert_eq!(result["env"]["ANTHROPIC_AUTH_TOKEN"], "secret");
        assert_eq!(result["hooks"], current["hooks"]);
    }

    #[test]
    fn untouched_stale_auth_keeps_external_provider_change() {
        let baseline = json!({"env":{"ANTHROPIC_AUTH_TOKEN":"old","X":"a"}});
        let current = json!({"env":{"ANTHROPIC_AUTH_TOKEN":"new","X":"a","Y":"external"}});
        let desired = json!({"env":{"ANTHROPIC_AUTH_TOKEN":"old","X":"b"}});
        let result = merged(&current, &desired, Some(&baseline)).unwrap();
        assert_eq!(result["env"]["ANTHROPIC_AUTH_TOKEN"], "new");
        assert_eq!(result["env"]["Y"], "external");
        assert_eq!(result["env"]["X"], "b");
    }

    #[test]
    fn edited_conflict_is_rejected_without_secret_values() {
        let baseline = json!({"env":{"TOKEN":"old-secret"}});
        let error = merged(&json!({"env":{"TOKEN":"external-secret"}}),
                           &json!({"env":{"TOKEN":"edited-secret"}}), Some(&baseline)).unwrap_err();
        assert!(error.contains("env.TOKEN"));
        assert!(!error.contains("secret"));
    }

    #[test]
    fn deletion_is_explicit_and_preserves_other_members() {
        let current = json!({"env":{"X":"a","TOKEN":"secret"}});
        assert_eq!(merged(&current, &json!({"env":{"X":null}}), None).unwrap()["env"], json!({"TOKEN":"secret"}));
        assert_eq!(merged(&current, &json!({"env":{"TOKEN":"secret"}}), Some(&current)).unwrap()["env"], json!({"TOKEN":"secret"}));
    }

    #[test]
    fn malformed_duplicate_and_nonstring_env_are_rejected() {
        assert!(parse(br#"{"env":{},"env":{"TOKEN":"hidden"}}"#).is_err());
        assert!(parse(br#"{"env":{"PCT":60}}"#).is_err());
        assert!(parse(br#"{"env":{"TOKEN":"secret"},}"#).is_err());
        assert!(parse(br#"{"hooks":{"Stop":[],"Stop":[]}}"#).is_err());
    }

    #[test]
    fn utf8_bom_does_not_hide_credentials_or_bypass_duplicate_validation() {
        assert_eq!(parse(b"\xef\xbb\xbf{\"env\":{\"TOKEN\":\"fixture\"}}").unwrap()["env"]["TOKEN"], "fixture");
        assert!(parse(b"\xef\xbb\xbf{\"env\":{},\"env\":{}}").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn long_settings_path_preserves_backup_access_and_publishes_without_auth_loss() {
        let mut root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../analysis/verification")
            .join(format!("anycode-long-settings-{}", uuid::Uuid::new_v4()));
        for index in 0..4 {
            root = root.join(format!("native-long-path-{index}-{}", "x".repeat(55)));
        }
        fs::create_dir_all(&root).unwrap();
        let path = root.join("settings.json");
        let before = b"\xef\xbb\xbf{\"env\":{\"ANTHROPIC_AUTH_TOKEN\":\"fixture-token\",\"ANTHROPIC_API_KEY\":\"fixture-key\"},\"unknown\":true}";
        fs::write(&path, before).unwrap();
        let original_access = FileAccess::capture(&path).unwrap();
        assert!(fs::canonicalize(&path).unwrap().as_os_str().len() > 260);
        let saved = update(&path, &json!({"env":{"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE":"60"}}), None).unwrap();
        assert_eq!(saved["env"]["ANTHROPIC_AUTH_TOKEN"], "fixture-token");
        assert_eq!(saved["env"]["ANTHROPIC_API_KEY"], "fixture-key");
        assert_eq!(saved["env"]["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"], "60");
        assert_eq!(saved["unknown"], true);
        let digest = format!("{:x}", Sha256::digest(before));
        let backup = root.join(format!("settings.before-anycode-repair-{digest}.json"));
        assert_eq!(fs::read(&backup).unwrap(), before);
        assert!(FileAccess::capture(&path).unwrap() == original_access);
        assert!(FileAccess::capture(&backup).unwrap() == original_access);
        assert_eq!(read(&path).unwrap(), saved);
    }

    #[test]
    #[ignore = "Explicit retained native settings lock contract only"]
    fn settings_guard_contract_process() {
        let root = std::path::PathBuf::from(std::env::var_os("CLAUDE_GUARD_CONTRACT_ROOT").expect("isolated root required"));
        let mode = std::env::var("CLAUDE_GUARD_CONTRACT_MODE").expect("contract mode required");
        if mode == "update" {
            update(&root.join("settings.json"), &json!({"env":{"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE":"60"}}), None).unwrap();
            println!("CONTRACT_UPDATED=settings");
            return;
        }
        match shared_writer(&root) {
            Ok(_guard) => {
                println!("CONTRACT_ACQUIRED=settings");
                if mode == "hold" {
                    fs::write(root.join("ready-settings-anycode.txt"), "ready").unwrap();
                    let end = std::time::Instant::now() + std::time::Duration::from_secs(30);
                    while !root.join("release-settings-anycode.txt").is_file() && std::time::Instant::now() < end {
                        std::thread::sleep(std::time::Duration::from_millis(20));
                    }
                    assert!(root.join("release-settings-anycode.txt").is_file(), "release signal timed out");
                }
            }
            Err(_) => println!("CONTRACT_BUSY=settings"),
        }
    }
}
