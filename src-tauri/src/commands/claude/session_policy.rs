//! Native per-session controls, trusted memory routing and shared OS leases.

use super::{get_claude_dir, settings_store};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::process::Command;

static OBSERVATIONS: LazyLock<Mutex<BTreeMap<String, Observation>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClaudeEffort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl ClaudeEffort {
    fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct ClaudeEffortOverride {
    pub level: Option<ClaudeEffort>,
}

impl From<ClaudeEffort> for ClaudeEffortOverride {
    fn from(level: ClaudeEffort) -> Self {
        Self { level: Some(level) }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Observation {
    pub active: bool,
    pub applied_percent: Option<u8>,
    #[serde(default)]
    pub applied_effort: Option<ClaudeEffort>,
    pub compaction_count: u64,
    pub current_tokens: Option<u64>,
    pub last_error: Option<String>,
    #[serde(skip)]
    last_boundary: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionPolicy {
    pub schema: u32,
    pub history_root: String,
    pub session_id: String,
    pub project_path: String,
    pub configured_percent: Option<u8>,
    #[serde(default)]
    pub configured_effort: Option<ClaudeEffort>,
    #[serde(default)]
    pub observation: Observation,
}

pub struct PreparedSession {
    pub session_id: String,
    pub history_root: String,
    pub key: String,
    pub lease: File,
}

impl Drop for PreparedSession {
    fn drop(&mut self) {
        finish(&self.key);
    }
}

pub fn normalize_identity(path: &str) -> String {
    let replaced = path.replace('\\', "/");
    let normalized = if let Some(unc) = replaced.strip_prefix("//?/UNC/") {
        format!("//{unc}")
    } else {
        replaced.strip_prefix("//?/").unwrap_or(&replaced).to_owned()
    };
    #[cfg(windows)]
    let normalized = normalized.to_lowercase();
    let mut normalized = normalized;
    while normalized.ends_with('/') && normalized.len() > 1
        && !(cfg!(windows) && normalized.len() == 3 && normalized.as_bytes()[1] == b':') {
        normalized.pop();
    }
    normalized
}

pub fn canonical_identity(path: &Path) -> Result<String, String> {
    let canonical = fs::canonicalize(path).map_err(|error| format!("Cannot resolve Claude session directory: {error}"))?;
    Ok(normalize_identity(&canonical.to_string_lossy()))
}

pub fn key_for_root(root: &str, session: &str) -> Result<String, String> {
    let id = uuid::Uuid::parse_str(session).map_err(|_| "Claude session ID must be a real UUID")?;
    Ok(format!("{:x}", Sha256::digest(format!("{root}\0claude\0{id}").as_bytes())))
}

fn path_for(root: &Path, id: &str) -> Result<PathBuf, String> {
    let key = key_for_root(&canonical_identity(root)?, id)?;
    Ok(root.join("anycode-session-policies").join(format!("{key}.json")))
}

fn load(root: &Path, id: &str, project: &Path) -> Result<SessionPolicy, String> {
    let history_root = canonical_identity(root)?;
    let project_path = canonical_identity(project)?;
    let session_id = uuid::Uuid::parse_str(id).map_err(|_| "Claude session ID must be a real UUID")?.to_string();
    let path = path_for(root, &session_id)?;
    let mut policy = if path.exists() {
        serde_json::from_value::<SessionPolicy>(settings_store::read(&path)?)
            .map_err(|_| "Stored Claude session policy is invalid")?
    } else {
        SessionPolicy { schema: 1, history_root: history_root.clone(), session_id: session_id.clone(),
                        project_path: project_path.clone(), configured_percent: None, configured_effort: None,
                        observation: Observation::default() }
    };
    if policy.schema != 1 || policy.history_root != history_root || policy.session_id != session_id
        || policy.project_path != project_path {
        return Err("Claude session policy belongs to a different history root or project".into());
    }
    if policy.configured_percent.is_some_and(|value| !(1..=100).contains(&value)) {
        return Err("Claude native compaction percentage must be between 1 and 100".into());
    }
    let key = key_for_root(&history_root, &session_id)?;
    policy.observation = OBSERVATIONS.lock().map_err(|_| "Claude session state unavailable")?
        .get(&key).cloned().unwrap_or_default();
    Ok(policy)
}

#[tauri::command]
pub fn get_claude_session_policy(session_id: String, project_path: String) -> Result<SessionPolicy, String> {
    let root = get_claude_dir().map_err(|error| error.to_string())?;
    load(&root, &session_id, Path::new(&project_path))
}

#[tauri::command]
pub fn set_claude_session_policy(
    app: AppHandle, session_id: String, project_path: String, percent: Option<u8>,
) -> Result<SessionPolicy, String> {
    if percent.is_some_and(|value| !(1..=100).contains(&value)) {
        return Err("Claude native compaction percentage must be between 1 and 100".into());
    }
    if percent.is_some() && super::managed_policy::constraints()?.compaction_percent {
        return Err("Claude managed policy controls compaction; use Follow Claude settings for this session".into());
    }
    let root = get_claude_dir().map_err(|error| error.to_string())?;
    let mut policy = load(&root, &session_id, Path::new(&project_path))?;
    save_policy_field(&root, &policy, "configured_percent", json!(percent))?;
    policy = load(&root, &session_id, Path::new(&project_path))?;
    let _ = app.emit("claude-native-policy", &policy);
    Ok(policy)
}

#[tauri::command]
pub fn set_claude_session_effort(
    app: AppHandle, session_id: String, project_path: String, effort: Option<ClaudeEffort>,
) -> Result<SessionPolicy, String> {
    if effort.is_some() && super::managed_policy::constraints()?.effort_level {
        return Err("Claude managed policy controls effort; use Follow Claude settings for this session".into());
    }
    let root = get_claude_dir().map_err(|error| error.to_string())?;
    let policy = load(&root, &session_id, Path::new(&project_path))?;
    save_policy_field(&root, &policy, "configured_effort", json!(effort))?;
    let policy = load(&root, &session_id, Path::new(&project_path))?;
    let _ = app.emit("claude-native-policy", &policy);
    Ok(policy)
}

fn save_policy_field(root: &Path, policy: &SessionPolicy, field: &str, value: Value) -> Result<(), String> {
    let path = path_for(root, &policy.session_id)?;
    if !path.exists() {
        let mut initial = policy.clone();
        initial.observation = Observation::default();
        settings_store::update(&path, &serde_json::to_value(initial)
            .map_err(|_| "Cannot encode Claude session policy")?, Some(&json!({})))?;
    }
    // Patch only the requested setting; another popover can save the other field.
    let mut patch = json!({});
    patch[field] = value;
    settings_store::update(&path, &patch, None)?;
    Ok(())
}

/// History mutations use the same per-root UUID lease as active work processes.
pub(crate) fn mutation_lease(root: &Path, session_id: &str) -> Result<File, String> {
    let key = key_for_root(&canonical_identity(root)?, session_id)?;
    shared_lease(root, &key)
}

fn shared_lease(root: &Path, key: &str) -> Result<File, String> {
    let directory = root.join("codex-session-guards");
    fs::create_dir_all(&directory).map_err(|error| format!("Cannot prepare Claude session guard: {error}"))?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    let file = options.open(directory.join(format!("{key}.lock")))
        .map_err(|_| "This Claude session is already running in another client; wait for it to finish")?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        extern "C" { fn flock(fd: std::ffi::c_int, operation: std::ffi::c_int) -> std::ffi::c_int; }
        if unsafe { flock(file.as_raw_fd(), 2 | 4) } != 0 {
            return Err("This Claude session is already running in another client; wait for it to finish".into());
        }
    }
    Ok(file)
}

fn prepared_memory(project: &Path, root: &Path) -> Result<Option<String>, String> {
    let directory = project.join(".claude").join("auto-memory");
    let ready = directory.join(".codex-memory-isolation.json");
    if !ready.is_file() || !directory.join("MEMORY.md").is_file() {
        return Ok(None);
    }
    if super::managed_policy::constraints()?.memory_directory {
        return Ok(None);
    }
    for source in [project.join(".claude/settings.local.json"), project.join(".claude/settings.json"),
                   root.join("settings.json")] {
        if source.exists() && settings_store::read(&source)?.get("autoMemoryDirectory").is_some() {
            return Ok(None);
        }
    }
    let metadata = settings_store::read(&ready)?;
    let owner = metadata.get("project_path").and_then(Value::as_str).ok_or("Memory isolation marker has no project")?;
    if metadata.get("schema").and_then(Value::as_u64) != Some(1)
        || metadata.get("prepared").and_then(Value::as_bool) != Some(true)
        || canonical_identity(Path::new(owner))? != canonical_identity(project)? {
        return Err("Memory isolation marker does not belong to the selected project".into());
    }
    Ok(Some(directory.to_string_lossy().to_string()))
}

fn validate_transcript_owner(root: &Path, session_id: &str, project: &Path) -> Result<(), String> {
    let projects = root.join("projects");
    if !projects.exists() {
        return Ok(());
    }
    let selected = fs::canonicalize(project).map_err(|_| "Selected Claude project cannot be resolved")?;
    for directory in fs::read_dir(projects).map_err(|_| "Cannot inspect Claude history root")? {
        let directory = directory.map_err(|_| "Cannot inspect Claude history directory")?;
        if !directory.file_type().map_err(|_| "Cannot inspect Claude history directory")?.is_dir() {
            continue;
        }
        let transcript = directory.path().join(format!("{session_id}.jsonl"));
        if !transcript.is_file() {
            continue;
        }
        let mut bytes = Vec::new();
        File::open(&transcript).map_err(|_| "Cannot read original Claude session metadata")?
            .take(256 * 1024).read_to_end(&mut bytes).map_err(|_| "Cannot read original Claude session metadata")?;
        let mut found = false;
        for line in bytes.split(|byte| *byte == b'\n') {
            let Some(record) = super::session_metadata::extract(&line[..line.len().min(65536)]) else { continue; };
            if record.session_id.as_deref() != Some(session_id) {
                continue;
            }
            let Some(cwd) = record.cwd.as_deref() else { continue; };
            let owner = fs::canonicalize(cwd).map_err(|_| "Original Claude project is unavailable; confirm its relocation before resuming")?;
            if !same_project(&owner, &selected) {
                return Err("This Claude session belongs to a different project; open its original project before resuming".into());
            }
            found = true;
            break;
        }
        if !found {
            return Err("Original Claude session project could not be confirmed within the metadata budget".into());
        }
    }
    Ok(())
}

fn same_project(original: &Path, selected: &Path) -> bool {
    if normalize_identity(&original.to_string_lossy()) == normalize_identity(&selected.to_string_lossy()) {
        return true;
    }
    if original.parent().is_none() || !selected.starts_with(original) {
        return false;
    }
    // A broad Git root cannot merge sibling projects; nested repositories differ.
    !selected.ancestors().take_while(|ancestor| *ancestor != original)
        .any(|ancestor| ancestor.join(".git").exists())
}

pub fn prepare(cmd: &mut Command, project: &str, effort: Option<ClaudeEffortOverride>) -> Result<PreparedSession, String> {
    let root = get_claude_dir().map_err(|error| error.to_string())?;
    prepare_for_root(cmd, project, &root, effort)
}

fn prepare_for_root(cmd: &mut Command, project: &str, root: &Path, effort: Option<ClaudeEffortOverride>) -> Result<PreparedSession, String> {
    for (name, value) in cmd.as_std().get_envs() {
        let name = name.to_string_lossy();
        if name.eq_ignore_ascii_case("CLAUDE_CONFIG_DIR") {
            let requested = value.map(Path::new).ok_or("Claude history root cannot be removed from this worker")?;
            if !requested.is_absolute() || canonical_identity(requested)? != canonical_identity(root)? {
                return Err("Claude worker history root differs from the client index; set CLAUDE_CONFIG_DIR before launching the client, rather than in settings.env".into());
            }
        }
        if name.eq_ignore_ascii_case("CLAUDE_CODE_PROJECT_DIR_NAME") {
            return Err("CLAUDE_CODE_PROJECT_DIR_NAME belongs in the client startup environment, not settings.env".into());
        }
    }
    let args: Vec<_> = cmd.as_std().get_args().map(|arg| arg.to_string_lossy().to_string()).collect();
    let existing_id = args.windows(2).find(|pair| pair[0] == "--resume" || pair[0] == "--session-id")
        .map(|pair| pair[1].clone());
    if args.iter().any(|arg| arg == "-c" || arg == "--continue") {
        return Err("Claude continuation must use an explicit original session UUID".into());
    }
    let session_id = existing_id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if existing_id.is_some() {
        validate_transcript_owner(&root, &session_id, Path::new(project))?;
    }
    let mut policy = load(root, &session_id, Path::new(project))?;
    let managed = super::managed_policy::constraints()?;
    if policy.configured_percent.is_some() && managed.compaction_percent {
        return Err("Claude managed policy controls compaction; reset this session to Follow Claude settings before resuming".into());
    }
    // No request restores the policy; an explicit null means inherit Claude defaults.
    let effective_effort = effort.map(|choice| choice.level).unwrap_or(policy.configured_effort);
    if effective_effort.is_some() && managed.effort_level {
        return Err("Claude managed policy controls effort; reset this session to Follow Claude settings before resuming".into());
    }
    if effective_effort.is_some() && args.iter().any(|arg| arg == "--effort" || arg.starts_with("--effort=")) {
        return Err("An explicit Claude effort argument is already present; it will not be overwritten".into());
    }
    let key = key_for_root(&policy.history_root, &session_id)?;
    let lease = shared_lease(root, &key)?;
    let policy_path = path_for(root, &session_id)?;
    if !policy_path.exists() {
        policy.configured_effort = effective_effort;
        settings_store::update(&policy_path, &serde_json::to_value(&policy)
            .map_err(|_| "Cannot preserve Claude session ownership")?, None)?;
    } else if effort.is_some() && effective_effort != policy.configured_effort {
        save_policy_field(root, &policy, "configured_effort", json!(effective_effort))?;
    }
    let mut settings = json!({});
    if let Some(percent) = policy.configured_percent {
        settings["env"] = json!({"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": percent.to_string()});
    }
    if let Some(memory) = prepared_memory(Path::new(project), &root)? {
        settings["autoMemoryDirectory"] = Value::String(memory);
    }
    if let Some(effort) = effective_effort {
        // The CLI flag wins over shared defaults without changing another worker.
        cmd.arg("--effort").arg(effort.as_str());
        cmd.env("CLAUDE_CODE_EFFORT_LEVEL", effort.as_str());
    }
    if !settings.as_object().expect("settings object").is_empty() {
        if args.iter().any(|arg| arg == "--settings") {
            return Err("An explicit Claude settings argument is already present; it will not be overwritten".into());
        }
        cmd.arg("--settings").arg(settings.to_string());
    }
    if existing_id.is_none() {
        cmd.arg("--session-id").arg(&session_id);
    }
    let mut observations = OBSERVATIONS.lock().map_err(|_| "Claude session state unavailable")?;
    if observations.len() >= 512 && !observations.contains_key(&key) {
        let stale = observations.iter().find(|(_, value)| !value.active).map(|(key, _)| key.clone());
        if let Some(stale) = stale {
            observations.remove(&stale);
        } else {
            return Err("Claude active session registry reached its resource budget".into());
        }
    }
    let observation = observations.entry(key.clone()).or_default();
    observation.active = true;
    observation.applied_percent = policy.configured_percent;
    observation.applied_effort = effective_effort;
    observation.last_error = None;
    Ok(PreparedSession { session_id, history_root: policy.history_root, key, lease })
}

pub fn observe(prepared: &PreparedSession, event: &Value) -> Result<bool, String> {
    if event.get("type").and_then(Value::as_str) == Some("system")
        && event.get("subtype").and_then(Value::as_str) == Some("init")
        && event.get("session_id").and_then(Value::as_str) != Some(prepared.session_id.as_str()) {
        return Err("Claude returned a different session UUID; refusing to attach it to this tab".into());
    }
    let mut observations = OBSERVATIONS.lock().map_err(|_| "Claude session state unavailable")?;
    let observation = observations.entry(prepared.key.clone()).or_default();
    if event.get("type").and_then(Value::as_str) == Some("assistant") {
        if let Some(usage) = event.pointer("/message/usage").or_else(|| event.get("usage")) {
            observation.current_tokens = Some(["input_tokens", "cache_creation_input_tokens",
                "cache_read_input_tokens", "output_tokens"].iter()
                .map(|key| usage.get(key).and_then(Value::as_u64).unwrap_or(0)).sum());
        }
    }
    let boundary = event.get("type").and_then(Value::as_str) == Some("system")
        && event.get("subtype").and_then(Value::as_str) == Some("compact_boundary");
    if boundary {
        let identity = event.get("uuid").and_then(Value::as_str).map(str::to_owned)
            .unwrap_or_else(|| format!("{:x}", Sha256::digest(event.to_string().as_bytes())));
        if observation.last_boundary != identity {
            observation.last_boundary = identity;
            observation.compaction_count += 1;
            observation.current_tokens = None;
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn finish(key: &str) {
    if let Ok(mut observations) = OBSERVATIONS.lock() {
        if let Some(observation) = observations.get_mut(key) {
            observation.active = false;
        }
    }
}

#[cfg(test)]
#[path = "session_policy_tests.rs"]
mod tests;
