//! Logical project ownership is independent of Claude's lossy history directory names.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use super::{get_claude_dir, session_metadata, session_policy};

const PROJECT_PREFIX: &str = "claude-project-";
const UNVERIFIED_PREFIX: &str = "claude-unverified-";
const METADATA_BUDGET: u64 = 256 * 1024;

#[derive(Clone, Debug)]
pub(crate) struct TranscriptLocation {
    pub session_id: String,
    pub storage_id: String,
    pub path: PathBuf,
    pub project_path: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct ProjectGroup {
    pub id: String,
    pub path: Option<String>,
    pub storage_ids: BTreeSet<String>,
    pub transcripts: Vec<TranscriptLocation>,
}

#[derive(Serialize)]
pub struct ResolvedSessionIdentity {
    pub session_id: String,
    pub project_id: String,
    pub project_path: String,
    pub project_verified: bool,
}

pub(crate) fn validate_session_id(session_id: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(session_id)
        .map_err(|_| "Claude session ID must be a real UUID".to_string())?;
    Ok(())
}

pub(crate) fn project_id_for_path(project_path: &str) -> Result<String, String> {
    if !Path::new(project_path).is_absolute() {
        return Err("Claude project ownership requires an absolute working directory".into());
    }
    Ok(format!(
        "{PROJECT_PREFIX}{:x}",
        Sha256::digest(session_policy::normalize_identity(project_path).as_bytes(),)
    ))
}

fn unverified_id(storage_id: &str) -> String {
    format!(
        "{UNVERIFIED_PREFIX}{:x}",
        Sha256::digest(storage_id.as_bytes())
    )
}

pub(crate) fn is_logical_project_id(project_id: &str) -> bool {
    project_id
        .strip_prefix(PROJECT_PREFIX)
        .or_else(|| project_id.strip_prefix(UNVERIFIED_PREFIX))
        .is_some_and(|digest| {
            digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
}

fn safe_storage_id(project_id: &str) -> bool {
    !project_id.is_empty()
        && project_id != "."
        && project_id != ".."
        && !project_id
            .chars()
            .any(|value| matches!(value, '/' | '\\' | ':'))
}

/// Only the first main-chain record with the original UUID can establish ownership.
pub(crate) fn transcript_owner(path: &Path, session_id: &str) -> Result<Option<String>, String> {
    let file = File::open(path)
        .map_err(|error| format!("Cannot read Claude session metadata: {error}"))?;
    transcript_owner_from_reader(file, session_id)
}

pub(crate) fn transcript_owner_from_reader<R: Read>(
    source: R,
    session_id: &str,
) -> Result<Option<String>, String> {
    let mut reader = BufReader::with_capacity(8192, source.take(METADATA_BUDGET));
    let mut prefix = Vec::with_capacity(8192);
    loop {
        let bytes = reader
            .fill_buf()
            .map_err(|error| format!("Cannot read Claude session metadata: {error}"))?;
        if bytes.is_empty() {
            break;
        }
        let newline = bytes.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map(|offset| offset + 1).unwrap_or(bytes.len());
        let captured = consumed.min(65536 - prefix.len());
        prefix.extend_from_slice(&bytes[..captured]);
        if let Some(record) = session_metadata::extract(&prefix) {
            if record.session_id.as_deref() == Some(session_id) {
                if let Some(cwd) = record.cwd.filter(|cwd| Path::new(cwd).is_absolute()) {
                    return Ok(Some(cwd));
                }
            }
        }
        reader.consume(consumed);
        if newline.is_some() {
            prefix.clear();
        }
    }
    Ok(None)
}

fn storage_directories(root: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let projects = root.join("projects");
    if !projects.exists() {
        return Ok(Vec::new());
    }
    let mut directories = Vec::new();
    for entry in
        fs::read_dir(&projects).map_err(|error| format!("Cannot list Claude history: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Cannot inspect Claude history: {error}"))?;
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            continue;
        }
        if let Some(id) = entry.file_name().to_str().filter(|id| safe_storage_id(id)) {
            directories.push((id.to_owned(), entry.path()));
        }
    }
    directories.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(directories)
}

pub(crate) fn scan_projects(root: &Path) -> Result<Vec<ProjectGroup>, String> {
    let mut groups: BTreeMap<String, ProjectGroup> = BTreeMap::new();
    for (storage_id, directory) in storage_directories(root)? {
        let mut locations = Vec::new();
        for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            if !entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_file()
            {
                continue;
            }
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(session_id) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            if validate_session_id(session_id).is_err() {
                continue;
            }
            let owner = transcript_owner(&path, session_id).unwrap_or_else(|error| {
                log::warn!(
                    "Claude history ownership is unavailable for {}: {}",
                    session_id,
                    error
                );
                None
            });
            locations.push(TranscriptLocation {
                session_id: session_id.to_owned(),
                storage_id: storage_id.clone(),
                project_path: owner,
                path,
            });
        }
        locations.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        if locations.is_empty() {
            let id = unverified_id(&storage_id);
            groups.entry(id.clone()).or_insert_with(|| ProjectGroup {
                id,
                path: None,
                storage_ids: BTreeSet::from([storage_id.clone()]),
                transcripts: Vec::new(),
            });
        }
        for location in locations {
            let id = match location.project_path.as_deref() {
                Some(path) => project_id_for_path(path)?,
                None => unverified_id(&storage_id),
            };
            let group = groups.entry(id.clone()).or_insert_with(|| ProjectGroup {
                id,
                path: location.project_path.clone(),
                storage_ids: BTreeSet::new(),
                transcripts: Vec::new(),
            });
            group.storage_ids.insert(storage_id.clone());
            group.transcripts.push(location);
        }
    }
    Ok(groups.into_values().collect())
}

pub(crate) fn resolve_project(root: &Path, project_id: &str) -> Result<ProjectGroup, String> {
    let mut matches: Vec<_> = scan_projects(root)?
        .into_iter()
        .filter(|group| {
            group.id == project_id
                || (!is_logical_project_id(project_id)
                    && safe_storage_id(project_id)
                    && group.storage_ids.contains(project_id))
        })
        .collect();
    match matches.len() {
        1 => Ok(matches.remove(0)),
        0 => Err("Claude project was not found; refresh the project list".into()),
        _ => Err("This old project ID contains sessions from different working directories; refresh the project list and select the original project".into()),
    }
}

pub(crate) fn resolve_session(
    root: &Path,
    project_id: &str,
    session_id: &str,
) -> Result<TranscriptLocation, String> {
    resolve_session_with_legacy_mode(root, project_id, session_id, true)
}

pub(crate) fn resolve_session_for_mutation(
    root: &Path,
    project_id: &str,
    session_id: &str,
) -> Result<TranscriptLocation, String> {
    resolve_session_with_legacy_mode(root, project_id, session_id, false)
}

fn resolve_session_with_legacy_mode(
    root: &Path,
    project_id: &str,
    session_id: &str,
    allow_missing_legacy_slug: bool,
) -> Result<TranscriptLocation, String> {
    validate_session_id(session_id)?;
    if !is_logical_project_id(project_id) && !safe_storage_id(project_id) {
        return Err("Invalid Claude history project ID".into());
    }
    let directories = storage_directories(root)?;
    let exact_storage_exists = directories.iter().any(|(id, _)| id == project_id);
    let mut matches = Vec::new();
    let mut files_with_uuid = 0;
    for (storage_id, directory) in directories {
        let path = directory.join(format!("{session_id}.jsonl"));
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.file_type().is_file() {
            continue;
        }
        files_with_uuid += 1;
        let owner = transcript_owner(&path, session_id)?;
        let actual_id = match owner.as_deref() {
            Some(cwd) => project_id_for_path(cwd)?,
            None => unverified_id(&storage_id),
        };
        let accepted = if is_logical_project_id(project_id) {
            actual_id == project_id
        } else {
            // A missing legacy slug may be repaired only by a unique original UUID.
            (allow_missing_legacy_slug && !exact_storage_exists) || storage_id == project_id
        };
        if accepted {
            matches.push(TranscriptLocation {
                session_id: session_id.to_owned(),
                storage_id,
                path,
                project_path: owner,
            });
        }
    }
    if files_with_uuid > 1 {
        return Err("The original Claude session UUID exists in multiple history files; its location is ambiguous".into());
    }
    match matches.len() {
        1 => Ok(matches.remove(0)),
        0 => Err("Claude session was not found in the selected project; refresh its original project".into()),
        _ => Err("The original Claude session UUID exists in multiple history files; its location is ambiguous".into()),
    }
}

pub(crate) fn resolve_optional_session(
    root: &Path,
    project_id: &str,
    session_id: &str,
) -> Result<Option<TranscriptLocation>, String> {
    resolve_optional_session_with_legacy_mode(root, project_id, session_id, true)
}

pub(crate) fn resolve_optional_session_for_mutation(
    root: &Path,
    project_id: &str,
    session_id: &str,
) -> Result<Option<TranscriptLocation>, String> {
    resolve_optional_session_with_legacy_mode(root, project_id, session_id, false)
}

fn resolve_optional_session_with_legacy_mode(
    root: &Path,
    project_id: &str,
    session_id: &str,
    allow_missing_legacy_slug: bool,
) -> Result<Option<TranscriptLocation>, String> {
    validate_session_id(session_id)?;
    let exists = storage_directories(root)?
        .into_iter()
        .any(|(_, directory)| {
            fs::symlink_metadata(directory.join(format!("{session_id}.jsonl")))
                .is_ok_and(|metadata| metadata.file_type().is_file())
        });
    if exists {
        resolve_session_with_legacy_mode(root, project_id, session_id, allow_missing_legacy_slug)
            .map(Some)
    } else {
        Ok(None)
    }
}

pub(crate) fn validate_selected_project(
    root: &Path,
    project_id: &str,
    session_id: &str,
    project_path: &str,
) -> Result<(), String> {
    let expected_id = project_id_for_path(project_path)?;
    if is_logical_project_id(project_id) && project_id != expected_id {
        return Err("Selected Claude working directory does not belong to this project".into());
    }
    if let Some(location) = resolve_optional_session_for_mutation(root, project_id, session_id)? {
        let owner = location
            .project_path
            .ok_or("Original Claude project is unconfirmed; this history is read-only")?;
        if project_id_for_path(&owner)? != expected_id {
            return Err(
                "The original Claude session belongs to a different working directory".into(),
            );
        }
    }
    Ok(())
}

/// New records are keyed by UUID so they do not require guessing a CLI directory before its first turn.
pub(crate) fn detached_git_records_path(root: &Path, session_id: &str) -> Result<PathBuf, String> {
    validate_session_id(session_id)?;
    Ok(root
        .join("anycode-session-records")
        .join(format!("{session_id}.git-records.json")))
}

pub(crate) fn native_directory_for_new_session(
    root: &Path,
    project_path: &str,
) -> Result<PathBuf, String> {
    project_id_for_path(project_path)?;
    if std::env::var_os("CLAUDE_CONFIG_DIR").is_some_and(|value| !value.is_empty()) {
        if let Ok(name) = std::env::var("CLAUDE_CODE_PROJECT_DIR_NAME") {
            let lower = name.to_ascii_lowercase();
            let reserved = matches!(lower.as_str(), "con" | "prn" | "aux" | "nul")
                || ((lower.starts_with("com") || lower.starts_with("lpt"))
                    && lower.len() == 4
                    && lower.as_bytes()[3].is_ascii_digit());
            if !reserved
                && !name.is_empty()
                && name.len() <= 64
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            {
                return Ok(root.join("projects").join(name));
            }
        }
    }
    // Match the native CLI's UTF-16 non-ASCII replacement; long-name hashing is version-specific.
    let storage_id: String = project_path
        .encode_utf16()
        .map(|unit| {
            if unit <= 127 && (unit as u8).is_ascii_alphanumeric() {
                unit as u8 as char
            } else {
                '-'
            }
        })
        .collect();
    if storage_id.len() > 200 {
        return Err("Claude conversion cannot infer this CLI version's long-path history name; use a verified named project directory before converting".into());
    }
    Ok(root.join("projects").join(storage_id))
}

#[tauri::command]
pub fn resolve_claude_project_identity(project_path: String) -> Result<String, String> {
    project_id_for_path(&project_path)
}

#[tauri::command]
pub fn resolve_claude_session_identity(
    session_id: String,
    project_id: String,
) -> Result<ResolvedSessionIdentity, String> {
    let root = get_claude_dir().map_err(|error| error.to_string())?;
    let location = resolve_session(&root, &project_id, &session_id)?;
    let id = match location.project_path.as_deref() {
        Some(cwd) => project_id_for_path(cwd)?,
        None => unverified_id(&location.storage_id),
    };
    Ok(ResolvedSessionIdentity {
        session_id,
        project_id: id,
        project_verified: location.project_path.is_some(),
        project_path: location.project_path.unwrap_or_default(),
    })
}
