use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

use serde_json::Value;

use super::models::{Project, Session};
use super::paths::get_claude_dir;
use super::project_identity::{self, ProjectGroup, TranscriptLocation};
use super::session_history::{extract_first_user_message, extract_session_summary};
use super::session_policy;

#[cfg(test)]
#[path = "project_identity_tests.rs"]
mod identity_tests;

pub struct ProjectStore {
    claude_dir: PathBuf,
}

pub struct BatchDeleteOutcome {
    pub deleted_count: usize,
    pub failed_count: usize,
    pub errors: Vec<String>,
}

impl ProjectStore {
    pub fn new() -> Result<Self, String> {
        let claude_dir = get_claude_dir().map_err(|e| e.to_string())?;
        Ok(Self { claude_dir })
    }

    pub fn list_projects(&self) -> Result<Vec<Project>, String> {
        let groups = project_identity::scan_projects(&self.claude_dir)?;
        let hidden = self.canonical_hidden_ids(&groups)?;
        let mut projects: Vec<_> = groups
            .into_iter()
            .filter(|group| !hidden.contains(&group.id))
            .map(|group| self.project_from_group(group))
            .collect();
        projects.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(projects)
    }

    pub fn get_project_sessions(&self, project_id: &str) -> Result<Vec<Session>, String> {
        log::info!("Getting sessions for project: {}", project_id);

        let group = project_identity::resolve_project(&self.claude_dir, project_id)?;
        let todos_dir = self.todos_dir();
        let mut sessions = Vec::new();
        let mut seen = HashSet::new();
        for location in group.transcripts {
            let path = location.path;
            let session_id = location.session_id.as_str();
            if seen.insert(session_id.to_owned()) {
                let metadata = fs::metadata(&path)
                    .map_err(|e| format!("Failed to read file metadata: {}", e))?;

                let created_at = metadata
                    .created()
                    .or_else(|_| metadata.modified())
                    .unwrap_or(SystemTime::UNIX_EPOCH)
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();

                let (first_message_raw, message_timestamp) = extract_first_user_message(&path);
                let (last_message_timestamp, model) = extract_session_summary(&path);

                // ✅ Fallback: 如果 first_message 为空，使用默认文本以确保会话能显示
                // 这样即使所有用户消息都被过滤掉，会话仍然可见
                let first_message = first_message_raw.or_else(|| {
                    // 检查会话是否真的有内容：
                    // 1. 有 last_message_timestamp，说明有消息
                    // 2. 文件大小 > 100 字节（排除几乎空的会话文件）
                    let has_content = last_message_timestamp.is_some()
                        && path.metadata().ok().map(|m| m.len() > 100).unwrap_or(false);

                    if has_content {
                        // 只显示 session_id 的前8位，避免 UI 过长
                        let short_id = if session_id.len() >= 8 {
                            &session_id[..8]
                        } else {
                            session_id
                        };
                        Some(format!("Resumed Session ({}...)", short_id))
                    } else {
                        // 真正的空会话
                        None
                    }
                });

                let todo_path = todos_dir.join(format!("{}.json", session_id));
                let todo_data = if todo_path.exists() {
                    fs::read_to_string(&todo_path)
                        .ok()
                        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
                } else {
                    None
                };

                sessions.push(Session {
                    id: session_id.to_string(),
                    project_id: group.id.clone(),
                    project_path: location.project_path.unwrap_or_default(),
                    todo_data,
                    created_at,
                    first_message,
                    message_timestamp,
                    last_message_timestamp,
                    model,
                });
            }
        }

        sessions.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(sessions)
    }

    pub fn delete_session(&self, project_id: &str, session_id: &str) -> Result<bool, String> {
        log::info!(
            "Deleting session {} from project {}",
            session_id,
            project_id
        );

        let location = project_identity::resolve_session_for_mutation(
            &self.claude_dir,
            project_id,
            session_id,
        )?;
        let _lease = session_policy::mutation_lease(&self.claude_dir, session_id)?;
        self.delete_verified_session(location)
    }

    fn delete_verified_session(&self, location: TranscriptLocation) -> Result<bool, String> {
        let session_id = location.session_id.as_str();
        let session_file = location.path;
        let project_dir = session_file
            .parent()
            .ok_or("Claude session storage directory is unavailable")?;
        fs::remove_file(&session_file)
            .map_err(|e| format!("Failed to delete session file: {}", e))?;

        let todo_file = self
            .claude_dir
            .join("todos")
            .join(format!("{}.json", session_id));

        if todo_file.exists() {
            fs::remove_file(&todo_file)
                .map_err(|e| format!("Failed to delete TODO file: {}", e))?;
            log::info!("Deleted TODO file: {:?}", todo_file);
        }

        for records in [
            project_dir
                .join("sessions")
                .join(format!("{session_id}.git-records.json")),
            self.claude_dir
                .join("sessions")
                .join(&location.storage_id)
                .join(format!("{session_id}.git-records.json")),
            self.claude_dir
                .join("anycode-session-records")
                .join(format!("{session_id}.git-records.json")),
        ] {
            if records.is_file() {
                fs::remove_file(&records)
                    .map_err(|error| format!("Failed to delete session git records: {error}"))?;
            }
        }
        Ok(true)
    }

    pub fn delete_sessions_batch(
        &self,
        project_id: &str,
        session_ids: &[String],
    ) -> BatchDeleteOutcome {
        let mut deleted_count = 0;
        let mut failed_count = 0;
        let mut errors = Vec::new();

        for session_id in session_ids {
            match self.delete_session(project_id, session_id) {
                Ok(session_deleted) => {
                    if session_deleted {
                        deleted_count += 1;
                    } else {
                        failed_count += 1;
                        errors.push(format!("Session file not found for ID: {}", session_id));
                    }
                }
                Err(e) => {
                    failed_count += 1;
                    errors.push(format!("Failed to delete session {}: {}", session_id, e));
                }
            }
        }

        BatchDeleteOutcome {
            deleted_count,
            failed_count,
            errors,
        }
    }

    pub fn hide_project(&self, project_id: &str) -> Result<bool, String> {
        let project_id = project_identity::resolve_project(&self.claude_dir, project_id)?.id;
        let mut hidden_projects = self.load_hidden_projects()?;
        if hidden_projects.contains(&project_id) {
            return Ok(false);
        }

        hidden_projects.push(project_id);
        self.save_hidden_projects(&hidden_projects)?;
        Ok(true)
    }

    pub fn restore_project(&self, project_id: &str) -> Result<(), String> {
        let group = project_identity::resolve_project(&self.claude_dir, project_id)?;
        let groups = project_identity::scan_projects(&self.claude_dir)?;
        let mut hidden_projects = self.load_hidden_projects()?;
        let previous_count = hidden_projects.len();
        hidden_projects.retain(|id| {
            if id == project_id || id == &group.id {
                return false;
            }
            let matches: Vec<_> = groups
                .iter()
                .filter(|candidate| candidate.storage_ids.contains(id))
                .collect();
            matches.len() != 1 || matches[0].id != group.id
        });
        if hidden_projects.len() != previous_count {
            self.save_hidden_projects(&hidden_projects)?;
            Ok(())
        } else {
            Err(format!(
                "Project '{}' is not in the hidden list",
                project_id
            ))
        }
    }

    pub fn delete_project_permanently(&self, project_id: &str) -> Result<String, String> {
        let group = project_identity::resolve_project(&self.claude_dir, project_id)?;
        // Verify all UUID locations before changing any file in a shared storage directory.
        let mut leases = Vec::new();
        let mut locations = Vec::new();
        for location in &group.transcripts {
            locations.push(project_identity::resolve_session_for_mutation(
                &self.claude_dir,
                &group.id,
                &location.session_id,
            )?);
            leases.push(session_policy::mutation_lease(
                &self.claude_dir,
                &location.session_id,
            )?);
        }
        for location in locations {
            self.delete_verified_session(location)?;
        }
        // Shared memory and unrelated sessions remain in their original directory.
        for storage_id in &group.storage_ids {
            let directory = self.projects_dir().join(storage_id);
            if fs::read_dir(&directory)
                .map_err(|error| error.to_string())?
                .next()
                .is_none()
            {
                fs::remove_dir(&directory).map_err(|error| error.to_string())?;
            }
        }
        self.remove_from_hidden_projects(&[project_id, &group.id])?;
        Ok(group.id)
    }

    pub fn list_hidden_projects(&self) -> Result<Vec<String>, String> {
        let groups = project_identity::scan_projects(&self.claude_dir)?;
        let mut ids: Vec<_> = self.canonical_hidden_ids(&groups)?.into_iter().collect();
        ids.sort();
        Ok(ids)
    }

    pub fn list_hidden_project_details(&self) -> Result<Vec<Project>, String> {
        let groups = project_identity::scan_projects(&self.claude_dir)?;
        let hidden = self.canonical_hidden_ids(&groups)?;
        Ok(groups
            .into_iter()
            .filter(|group| hidden.contains(&group.id))
            .map(|group| self.project_from_group(group))
            .collect())
    }

    fn projects_dir(&self) -> PathBuf {
        self.claude_dir.join("projects")
    }

    fn todos_dir(&self) -> PathBuf {
        self.claude_dir.join("todos")
    }

    fn load_hidden_projects(&self) -> Result<Vec<String>, String> {
        let hidden_projects_file = self.hidden_projects_file();

        if hidden_projects_file.exists() {
            let content = fs::read_to_string(&hidden_projects_file)
                .map_err(|e| format!("Failed to read hidden projects file: {}", e))?;
            Ok(serde_json::from_str(&content).unwrap_or_else(|_| Vec::new()))
        } else {
            Ok(Vec::new())
        }
    }

    fn save_hidden_projects(&self, projects: &[String]) -> Result<(), String> {
        let hidden_projects_file = self.hidden_projects_file();
        let content = serde_json::to_string_pretty(projects)
            .map_err(|e| format!("Failed to serialize hidden projects: {}", e))?;
        fs::write(&hidden_projects_file, content)
            .map_err(|e| format!("Failed to write hidden projects file: {}", e))
    }

    fn hidden_projects_file(&self) -> PathBuf {
        self.claude_dir.join("hidden_projects.json")
    }

    fn project_from_group(&self, group: ProjectGroup) -> Project {
        let mut sessions = HashSet::new();
        let mut latest_activity = 0;
        for location in group.transcripts {
            sessions.insert(location.session_id);
            if let Ok(metadata) = fs::metadata(location.path) {
                let modified = metadata
                    .modified()
                    .unwrap_or(SystemTime::UNIX_EPOCH)
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                latest_activity = latest_activity.max(modified);
            }
        }
        if sessions.is_empty() {
            for storage_id in &group.storage_ids {
                if let Ok(metadata) = fs::metadata(self.projects_dir().join(storage_id)) {
                    let modified = metadata
                        .modified()
                        .unwrap_or(SystemTime::UNIX_EPOCH)
                        .duration_since(SystemTime::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();
                    latest_activity = latest_activity.max(modified);
                }
            }
        }
        let mut sessions: Vec<_> = sessions.into_iter().collect();
        sessions.sort();
        Project {
            id: group.id,
            path: group.path.unwrap_or_default(),
            sessions,
            created_at: latest_activity,
        }
    }

    fn canonical_hidden_ids(&self, groups: &[ProjectGroup]) -> Result<HashSet<String>, String> {
        let mut hidden = HashSet::new();
        for stored_id in self.load_hidden_projects()? {
            if let Some(group) = groups.iter().find(|group| group.id == stored_id) {
                hidden.insert(group.id.clone());
                continue;
            }
            let matches: Vec<_> = groups
                .iter()
                .filter(|group| group.storage_ids.contains(&stored_id))
                .collect();
            if matches.len() == 1 {
                hidden.insert(matches[0].id.clone());
            } else if matches.len() > 1 {
                log::warn!("An old hidden project ID has ambiguous cwd ownership; keeping its sessions visible: {}", stored_id);
            }
        }
        Ok(hidden)
    }

    fn remove_from_hidden_projects(&self, project_ids: &[&str]) -> Result<(), String> {
        let hidden_projects_file = self.hidden_projects_file();
        if hidden_projects_file.exists() {
            let mut hidden_projects = self.load_hidden_projects()?;
            let original_len = hidden_projects.len();
            hidden_projects.retain(|id| !project_ids.contains(&id.as_str()));

            if hidden_projects.len() != original_len {
                self.save_hidden_projects(&hidden_projects)?;
                log::info!(
                    "Removed project(s) from hidden list: {}",
                    project_ids.join(", ")
                );
            }
        }
        Ok(())
    }
}
