//! Isolated transcript fixtures; these never inspect the user's Claude history.

use super::ProjectStore;
use crate::commands::claude::{project_identity, session_history};
use serde_json::{json, Value};
use std::cell::Cell;
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::rc::Rc;

const FIRST: &str = "00000000-0000-4000-8000-000000000001";
const SECOND: &str = "00000000-0000-4000-8000-000000000002";

fn cwd(root: &Path, name: &str) -> String {
    root.join(name).to_string_lossy().to_string()
}

fn record(id: &str, project: &str, text: &str) -> Value {
    json!({ "type": "user", "sessionId": id, "cwd": project, "isSidechain": false,
        "message": { "role": "user", "content": text }, "timestamp": "2026-10-30T01:00:00Z" })
}

fn transcript(root: &Path, storage: &str, id: &str, entries: &[Value]) -> PathBuf {
    let directory = root.join("projects").join(storage);
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join(format!("{id}.jsonl"));
    let content = entries
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    fs::write(&path, content).unwrap();
    path
}

fn store(root: &Path) -> ProjectStore {
    ProjectStore {
        claude_dir: root.to_path_buf(),
    }
}

#[test]
fn chinese_cwd_collision_keeps_original_ids_paths_and_file_bytes() {
    let root = tempfile::tempdir().unwrap();
    let one = cwd(root.path(), "中文甲");
    let two = cwd(root.path(), "中文乙");
    let first = transcript(
        root.path(),
        "D-----",
        FIRST,
        &[record(FIRST, &one, "first project")],
    );
    let second = transcript(
        root.path(),
        "D-----",
        SECOND,
        &[record(SECOND, &two, "second project")],
    );
    let before = [fs::read(&first).unwrap(), fs::read(&second).unwrap()];
    let store = store(root.path());
    let projects = store.list_projects().unwrap();
    assert_eq!(projects.len(), 2);
    for (path, id) in [(&one, FIRST), (&two, SECOND)] {
        let project = projects
            .iter()
            .find(|project| &project.path == path)
            .unwrap();
        assert_eq!(project.sessions, vec![id]);
        assert_ne!(project.id, "D-----");
        let sessions = store.get_project_sessions(&project.id).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, id);
        assert_eq!(&sessions[0].project_path, path);
        let location = project_identity::resolve_session(root.path(), &project.id, id).unwrap();
        assert_eq!(
            location.path,
            root.path()
                .join("projects/D-----")
                .join(format!("{id}.jsonl"))
        );
    }
    assert_eq!(fs::read(first).unwrap(), before[0]);
    assert_eq!(fs::read(second).unwrap(), before[1]);
}

#[test]
fn original_main_chain_cwd_ignores_other_uuid_sidechain_and_later_chdir() {
    let root = tempfile::tempdir().unwrap();
    let original = cwd(root.path(), "中文丙");
    let other = cwd(root.path(), "中文丁");
    let mut sidechain = record(FIRST, &other, "agent");
    sidechain["isSidechain"] = json!(true);
    let path = transcript(
        root.path(),
        "D-----",
        FIRST,
        &[
            json!({ "message": { "sessionId": FIRST, "cwd": other, "type": "user" } }),
            record(SECOND, &other, "other UUID"),
            sidechain,
            record(FIRST, &original, "original"),
            record(FIRST, &other, "later chdir"),
        ],
    );
    assert_eq!(
        project_identity::transcript_owner(&path, FIRST)
            .unwrap()
            .as_deref(),
        Some(original.as_str())
    );
}

#[test]
fn mixed_legacy_project_operations_refuse_ambiguity_but_exact_history_remains_readable() {
    let root = tempfile::tempdir().unwrap();
    let one = cwd(root.path(), "中文甲");
    let two = cwd(root.path(), "中文乙");
    transcript(
        root.path(),
        "D-----",
        FIRST,
        &[record(FIRST, &one, "first project")],
    );
    transcript(
        root.path(),
        "D-----",
        SECOND,
        &[record(SECOND, &two, "second project")],
    );
    let store = store(root.path());
    assert!(store.get_project_sessions("D-----").is_err());
    assert!(store.hide_project("D-----").is_err());
    assert!(store.delete_project_permanently("D-----").is_err());
    let history =
        session_history::load_session_history_for_root(root.path(), FIRST, "D-----").unwrap();
    assert_eq!(history[0]["message"]["content"], "first project");
    let project_id = project_identity::project_id_for_path(&one).unwrap();
    assert!(project_identity::resolve_session(root.path(), &project_id, SECOND).is_err());
    assert!(
        project_identity::validate_selected_project(root.path(), &project_id, FIRST, &two).is_err()
    );
}

#[test]
fn a_missing_legacy_slug_is_repaired_only_by_one_original_uuid() {
    let root = tempfile::tempdir().unwrap();
    let project = cwd(root.path(), "中文甲");
    let path = transcript(
        root.path(),
        "actual-storage",
        FIRST,
        &[record(FIRST, &project, "original")],
    );
    let location =
        project_identity::resolve_session(root.path(), "missing-old-slug", FIRST).unwrap();
    assert_eq!(location.path, path);
    transcript(
        root.path(),
        "second-storage",
        FIRST,
        &[record(FIRST, &project, "duplicate")],
    );
    assert!(project_identity::resolve_session(root.path(), "missing-old-slug", FIRST).is_err());
    assert!(project_identity::resolve_session(
        root.path(),
        &project_identity::project_id_for_path(&project).unwrap(),
        FIRST
    )
    .is_err());
}

#[test]
fn one_cwd_in_multiple_physical_directories_loads_all_of_its_sessions() {
    let root = tempfile::tempdir().unwrap();
    let project = cwd(root.path(), "中文丙");
    transcript(
        root.path(),
        "legacy-one",
        FIRST,
        &[record(FIRST, &project, "one")],
    );
    transcript(
        root.path(),
        "native-two",
        SECOND,
        &[record(SECOND, &project, "two")],
    );
    let store = store(root.path());
    let projects = store.list_projects().unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].sessions.len(), 2);
    assert_eq!(
        store.get_project_sessions(&projects[0].id).unwrap().len(),
        2
    );
}

#[test]
fn hiding_one_logical_project_does_not_hide_its_chinese_sibling() {
    let root = tempfile::tempdir().unwrap();
    let one = cwd(root.path(), "中文甲");
    let two = cwd(root.path(), "中文乙");
    transcript(root.path(), "D-----", FIRST, &[record(FIRST, &one, "one")]);
    transcript(
        root.path(),
        "D-----",
        SECOND,
        &[record(SECOND, &two, "two")],
    );
    let store = store(root.path());
    let id = project_identity::project_id_for_path(&one).unwrap();
    store.hide_project(&id).unwrap();
    assert_eq!(store.list_projects().unwrap()[0].path, two);
    assert_eq!(store.list_hidden_project_details().unwrap()[0].path, one);
    store.restore_project(&id).unwrap();
    assert_eq!(store.list_projects().unwrap().len(), 2);
    fs::write(root.path().join("hidden_projects.json"), "[\"D-----\"]").unwrap();
    assert_eq!(store.list_projects().unwrap().len(), 2);
    assert_eq!(
        fs::read_to_string(root.path().join("hidden_projects.json")).unwrap(),
        "[\"D-----\"]"
    );
}

#[test]
fn deleting_one_logical_project_preserves_sibling_history_and_shared_memory() {
    let root = tempfile::tempdir().unwrap();
    let one = cwd(root.path(), "中文甲");
    let two = cwd(root.path(), "中文乙");
    let first = transcript(root.path(), "D-----", FIRST, &[record(FIRST, &one, "one")]);
    let second = transcript(
        root.path(),
        "D-----",
        SECOND,
        &[record(SECOND, &two, "two")],
    );
    let memory = root.path().join("projects/D-----/memory");
    fs::create_dir_all(&memory).unwrap();
    fs::write(memory.join("MEMORY.md"), "shared legacy memory remains").unwrap();
    store(root.path())
        .delete_project_permanently(&project_identity::project_id_for_path(&one).unwrap())
        .unwrap();
    assert!(!first.exists());
    assert!(second.exists());
    assert_eq!(
        fs::read_to_string(memory.join("MEMORY.md")).unwrap(),
        "shared legacy memory remains"
    );
}

#[test]
fn absent_or_relative_cwd_never_becomes_a_guessed_project_path() {
    let root = tempfile::tempdir().unwrap();
    transcript(
        root.path(),
        "D-----",
        FIRST,
        &[record(FIRST, "relative-project", "inspect only")],
    );
    let store = store(root.path());
    let project = store.list_projects().unwrap().remove(0);
    assert!(project.path.is_empty());
    assert!(project.id.starts_with("claude-unverified-"));
    assert_eq!(
        store.get_project_sessions(&project.id).unwrap()[0].project_path,
        ""
    );
    assert!(
        session_history::load_session_history_for_root(root.path(), FIRST, &project.id).is_ok()
    );
    assert!(project_identity::validate_selected_project(
        root.path(),
        &project.id,
        FIRST,
        &cwd(root.path(), "other")
    )
    .is_err());
    assert!(project_identity::resolve_session(root.path(), "../escape", FIRST).is_err());
    assert!(project_identity::resolve_session(root.path(), &project.id, "../../escape").is_err());
}

struct CountingReader {
    source: Cursor<Vec<u8>>,
    count: Rc<Cell<usize>>,
}

impl Read for CountingReader {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        let count = self.source.read(bytes)?;
        self.count.set(self.count.get() + count);
        Ok(count)
    }
}

#[test]
fn metadata_stops_after_the_first_buffer_before_a_large_image_payload() {
    let root = tempfile::tempdir().unwrap();
    let project = cwd(root.path(), "中文甲");
    let encoded = serde_json::to_string(&project).unwrap();
    let bytes = format!("{{\"sessionId\":\"{FIRST}\",\"cwd\":{encoded},\"type\":\"user\",\"isSidechain\":false,\"message\":\"{}\"}}\n", "x".repeat(400000)).into_bytes();
    let count = Rc::new(Cell::new(0));
    let reader = CountingReader {
        source: Cursor::new(bytes),
        count: count.clone(),
    };
    assert_eq!(
        project_identity::transcript_owner_from_reader(reader, FIRST)
            .unwrap()
            .as_deref(),
        Some(project.as_str())
    );
    assert!(count.get() <= 8192);
}

#[test]
fn metadata_fields_crossing_buffer_boundaries_are_still_found() {
    let root = tempfile::tempdir().unwrap();
    let project = cwd(root.path(), "中文丙");
    let encoded = serde_json::to_string(&project).unwrap();
    let bytes = format!("{{\"padding\":\"{}\",\"sessionId\":\"{FIRST}\",\"cwd\":{encoded},\"type\":\"user\",\"isSidechain\":false}}\n", "x".repeat(16375)).into_bytes();
    assert_eq!(
        project_identity::transcript_owner_from_reader(Cursor::new(bytes), FIRST)
            .unwrap()
            .as_deref(),
        Some(project.as_str())
    );
}

#[test]
fn oversized_unrelated_first_line_does_not_hide_a_later_trusted_header_within_budget() {
    let root = tempfile::tempdir().unwrap();
    let project = cwd(root.path(), "中文丁");
    let bytes = format!(
        "{{\"unrelated\":\"{}\"}}\n{}\n",
        "x".repeat(100000),
        record(FIRST, &project, "original")
    )
    .into_bytes();
    let count = Rc::new(Cell::new(0));
    let reader = CountingReader {
        source: Cursor::new(bytes),
        count: count.clone(),
    };
    assert_eq!(
        project_identity::transcript_owner_from_reader(reader, FIRST)
            .unwrap()
            .as_deref(),
        Some(project.as_str())
    );
    assert!(count.get() <= 256 * 1024);
}

#[test]
fn a_missing_legacy_slug_cannot_delete_or_rewind_the_globally_found_uuid() {
    let root = tempfile::tempdir().unwrap();
    let project = cwd(root.path(), "中文甲");
    let path = transcript(
        root.path(),
        "actual-storage",
        FIRST,
        &[record(FIRST, &project, "original")],
    );
    let before = fs::read(&path).unwrap();
    assert!(project_identity::resolve_session(root.path(), "missing-legacy", FIRST).is_ok());
    assert!(
        project_identity::resolve_session_for_mutation(root.path(), "missing-legacy", FIRST)
            .is_err()
    );
    assert!(project_identity::validate_selected_project(
        root.path(),
        "missing-legacy",
        FIRST,
        &project
    )
    .is_err());
    assert!(store(root.path())
        .delete_session("missing-legacy", FIRST)
        .is_err());
    assert_eq!(fs::read(path).unwrap(), before);
}

#[test]
fn a_running_session_cannot_be_deleted_while_its_shared_lease_is_held() {
    let root = tempfile::tempdir().unwrap();
    let project = cwd(root.path(), "中文甲");
    let path = transcript(
        root.path(),
        "actual-storage",
        FIRST,
        &[record(FIRST, &project, "original")],
    );
    let id = project_identity::project_id_for_path(&project).unwrap();
    let lease =
        crate::commands::claude::session_policy::mutation_lease(root.path(), FIRST).unwrap();
    assert!(store(root.path()).delete_session(&id, FIRST).is_err());
    assert!(path.exists());
    drop(lease);
    assert!(store(root.path()).delete_session(&id, FIRST).unwrap());
    assert!(!path.exists());
}

#[test]
fn whole_project_delete_locks_all_sessions_before_removing_any_transcript() {
    let root = tempfile::tempdir().unwrap();
    let project = cwd(root.path(), "中文丙");
    let one = transcript(
        root.path(),
        "actual-storage",
        FIRST,
        &[record(FIRST, &project, "one")],
    );
    let two = transcript(
        root.path(),
        "actual-storage",
        SECOND,
        &[record(SECOND, &project, "two")],
    );
    let lease =
        crate::commands::claude::session_policy::mutation_lease(root.path(), SECOND).unwrap();
    let id = project_identity::project_id_for_path(&project).unwrap();
    assert!(store(root.path()).delete_project_permanently(&id).is_err());
    assert!(one.exists());
    assert!(two.exists());
    drop(lease);
    assert!(store(root.path()).delete_project_permanently(&id).is_ok());
    assert!(!one.exists());
    assert!(!two.exists());
}
