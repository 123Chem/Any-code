//! Offline native policy contracts. Generated fixtures are retained for inspection.

use super::*;

fn fixture() -> (PathBuf, PathBuf) {
    let base = std::env::var_os("ANYCODE_REPAIR_FIXTURES").map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/repair-fixtures"));
    let base = base.join(uuid::Uuid::new_v4().to_string());
    let root = base.join("claude-history");
    let project = base.join("project-one");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&project).unwrap();
    (root, project)
}

fn transcript(root: &Path, id: &str, project: &Path) {
    let directory = root.join("projects/colliding-project-slug");
    fs::create_dir_all(&directory).unwrap();
    let row = json!({"sessionId": id, "cwd": project, "type": "user", "isSidechain": false,
                     "message": {"role": "user", "content": "offline fixture"}});
    fs::write(directory.join(format!("{id}.jsonl")), format!("{row}\n")).unwrap();
}

fn settings_overlay(cmd: &Command) -> Value {
    let args: Vec<_> = cmd.as_std().get_args().map(|value| value.to_string_lossy().to_string()).collect();
    let raw = args.windows(2).find(|pair| pair[0] == "--settings").unwrap();
    serde_json::from_str(&raw[1]).unwrap()
}

#[test]
fn same_uuid_in_different_roots_has_a_different_identity() {
    let id = "48fabfc3-2695-4bd0-9f95-4bbf62840332";
    assert_ne!(key_for_root("d:/claude-one", id).unwrap(), key_for_root("d:/claude-two", id).unwrap());
    assert_eq!(key_for_root("d:/claude-one", id).unwrap(), key_for_root("d:/claude-one", &id.to_uppercase()).unwrap());
}

#[test]
fn windows_verbatim_unc_and_volume_roots_are_normalized() {
    assert_eq!(normalize_identity("\\\\?\\UNC\\server\\share"), "//server/share");
    assert_eq!(normalize_identity("\\\\?\\D:\\Claude\\"), if cfg!(windows) { "d:/claude" } else { "D:/Claude" });
    assert_eq!(normalize_identity("/"), "/");
    if cfg!(windows) { assert_eq!(normalize_identity("D:/"), "d:/"); }
}

#[test]
fn native_sixty_overlay_preserves_authentication_environment_and_session() {
    let (root, project) = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    transcript(&root, &id, &project);
    let mut policy = load(&root, &id, &project).unwrap();
    policy.configured_percent = Some(60);
    settings_store::update(&path_for(&root, &id).unwrap(), &serde_json::to_value(policy).unwrap(), None).unwrap();
    let mut cmd = Command::new("not-executed-fixture");
    cmd.arg("--resume").arg(&id).env("ANTHROPIC_AUTH_TOKEN", "fixture-auth");
    let prepared = prepare_for_root(&mut cmd, project.to_str().unwrap(), &root, None).unwrap();
    assert_eq!(prepared.session_id, id);
    assert_eq!(settings_overlay(&cmd), json!({"env": {"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "60"}}));
    assert_eq!(cmd.as_std().get_envs().find(|(name, _)| *name == "ANTHROPIC_AUTH_TOKEN").unwrap().1.unwrap(), "fixture-auth");
    assert!(shared_lease(&root, &prepared.key).is_err());
    let key = prepared.key.clone();
    drop(prepared);
    assert!(shared_lease(&root, &key).is_ok());
}

#[test]
fn new_session_has_an_explicit_uuid_and_does_not_adopt_the_latest_history() {
    let (root, project) = fixture();
    let mut cmd = Command::new("not-executed-fixture");
    let prepared = prepare_for_root(&mut cmd, project.to_str().unwrap(), &root, None).unwrap();
    let args: Vec<_> = cmd.as_std().get_args().map(|value| value.to_string_lossy().to_string()).collect();
    assert_eq!(args, vec!["--session-id", prepared.session_id.as_str()]);
    let mut bad = Command::new("not-executed-fixture");
    bad.arg("-c");
    assert!(prepare_for_root(&mut bad, project.to_str().unwrap(), &root, None).is_err());
}

#[test]
fn sibling_projects_and_a_parent_cannot_resume_the_original_uuid() {
    let (root, project) = fixture();
    let sibling = project.parent().unwrap().join("project-two");
    fs::create_dir_all(&sibling).unwrap();
    fs::create_dir_all(project.parent().unwrap().join(".git")).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    transcript(&root, &id, &project);
    assert!(validate_transcript_owner(&root, &id, &sibling).is_err());
    assert!(validate_transcript_owner(&root, &id, project.parent().unwrap()).is_err());
    let child = project.join("src");
    fs::create_dir_all(&child).unwrap();
    assert!(validate_transcript_owner(&root, &id, &child).is_ok());
    fs::create_dir_all(child.join(".git")).unwrap();
    assert!(validate_transcript_owner(&root, &id, &child).is_err());
}

#[test]
fn a_large_first_message_retains_only_top_level_original_ownership() {
    let (root, project) = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    let directory = root.join("projects/large-message");
    fs::create_dir_all(&directory).unwrap();
    let mut raw = format!("{{\"sessionId\":{},\"cwd\":{},\"type\":\"user\",\"isSidechain\":false,\"message\":\"",
        serde_json::to_string(&id).unwrap(), serde_json::to_string(&project).unwrap());
    raw.push_str(&"x".repeat(300_000));
    raw.push_str("\"}\n");
    fs::write(directory.join(format!("{id}.jsonl")), raw).unwrap();
    assert!(validate_transcript_owner(&root, &id, &project).is_ok());
}

#[test]
fn only_prepared_project_memory_is_applied_and_explicit_user_memory_wins() {
    let (root, project) = fixture();
    let directory = project.join(".claude/auto-memory");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("MEMORY.md"), "# Project one\n").unwrap();
    assert!(prepared_memory(&project, &root).unwrap().is_none());
    settings_store::update(&directory.join(".codex-memory-isolation.json"),
        &json!({"schema": 1, "prepared": true, "project_path": project, "source_manifest": []}), None).unwrap();
    let mut cmd = Command::new("not-executed-fixture");
    let prepared = prepare_for_root(&mut cmd, project.to_str().unwrap(), &root, None).unwrap();
    let overlay = settings_overlay(&cmd);
    assert_eq!(canonical_identity(Path::new(overlay["autoMemoryDirectory"].as_str().unwrap())).unwrap(),
               canonical_identity(&directory).unwrap());
    drop(prepared);
    settings_store::update(&root.join("settings.json"), &json!({"autoMemoryDirectory": "D:/explicit-memory"}), None).unwrap();
    assert!(prepared_memory(&project, &root).unwrap().is_none());
}

#[test]
fn native_boundary_is_deduplicated_and_cache_usage_is_observed_without_fake_reduction() {
    let (root, project) = fixture();
    let mut cmd = Command::new("not-executed-fixture");
    let prepared = prepare_for_root(&mut cmd, project.to_str().unwrap(), &root, None).unwrap();
    observe(&prepared, &json!({"type": "assistant", "message": {"usage": {
        "input_tokens": 1000, "cache_creation_input_tokens": 2000,
        "cache_read_input_tokens": 500000, "output_tokens": 100}}})).unwrap();
    assert_eq!(load(&root, &prepared.session_id, &project).unwrap().observation.current_tokens, Some(503100));
    let boundary = json!({"type": "system", "subtype": "compact_boundary", "uuid": "boundary-1"});
    assert!(observe(&prepared, &boundary).unwrap());
    assert!(!observe(&prepared, &boundary).unwrap());
    let observation = load(&root, &prepared.session_id, &project).unwrap().observation;
    assert_eq!(observation.compaction_count, 1);
    assert_eq!(observation.current_tokens, None);
    assert!(observe(&prepared, &json!({"type": "system", "subtype": "init",
        "session_id": uuid::Uuid::new_v4().to_string()})).is_err());
}

#[test]
fn worker_root_cannot_drift_from_the_history_index_via_settings_environment() {
    let (root, project) = fixture();
    let other = root.parent().unwrap().join("other-history");
    fs::create_dir_all(&other).unwrap();
    let mut cmd = Command::new("not-executed-fixture");
    cmd.env("CLAUDE_CONFIG_DIR", &other);
    assert!(prepare_for_root(&mut cmd, project.to_str().unwrap(), &root, None).is_err());
    let mut same = Command::new("not-executed-fixture");
    same.env("CLAUDE_CONFIG_DIR", &root);
    assert!(prepare_for_root(&mut same, project.to_str().unwrap(), &root, None).is_ok());
}

#[test]
fn old_policy_inherits_defaults_and_unknown_ultra_is_rejected() {
    let old = json!({"schema": 1, "history_root": "history", "session_id": uuid::Uuid::new_v4(),
        "project_path": "project", "configured_percent": 60});
    let policy: SessionPolicy = serde_json::from_value(old).unwrap();
    assert_eq!(policy.configured_effort, None);
    assert_eq!(policy.observation.applied_effort, None);
    assert_eq!(serde_json::from_value::<ClaudeEffort>(json!("max")).unwrap(), ClaudeEffort::Max);
    assert!(serde_json::from_value::<ClaudeEffort>(json!("ultra")).is_err());
}

#[test]
fn new_max_is_saved_with_the_uuid_without_changing_shared_settings_or_auth() {
    let (root, project) = fixture();
    let shared = root.join("settings.json");
    settings_store::update(&shared, &json!({"env": {
        "ANTHROPIC_AUTH_TOKEN": "fixture-auth", "CLAUDE_CODE_EFFORT_LEVEL": "low"},
        "effortLevel": "high"}), None).unwrap();
    let original = fs::read(&shared).unwrap();
    let mut cmd = Command::new("not-executed-fixture");
    cmd.env("ANTHROPIC_AUTH_TOKEN", "fixture-auth").env("CLAUDE_CODE_EFFORT_LEVEL", "low");
    let prepared = prepare_for_root(&mut cmd, project.to_str().unwrap(), &root, Some(ClaudeEffort::Max.into())).unwrap();
    let args: Vec<_> = cmd.as_std().get_args().map(|value| value.to_string_lossy().to_string()).collect();
    assert_eq!(args[..2], ["--effort", "max"]);
    assert_eq!(args.last().unwrap(), &prepared.session_id);
    // The shared settings.env level would beat --effort; the flag overlay must carry the session level.
    assert_eq!(settings_overlay(&cmd), json!({"env": {"CLAUDE_CODE_EFFORT_LEVEL": "max"}}));
    let policy = load(&root, &prepared.session_id, &project).unwrap();
    assert_eq!(policy.configured_effort, Some(ClaudeEffort::Max));
    assert_eq!(policy.observation.applied_effort, Some(ClaudeEffort::Max));
    assert_eq!(cmd.as_std().get_envs().find(|(name, _)| *name == "CLAUDE_CODE_EFFORT_LEVEL").unwrap().1.unwrap(), "max");
    assert_eq!(cmd.as_std().get_envs().find(|(name, _)| *name == "ANTHROPIC_AUTH_TOKEN").unwrap().1.unwrap(), "fixture-auth");
    assert_eq!(fs::read(shared).unwrap(), original);
}

#[test]
fn resume_keeps_saved_max_and_sixty_with_original_session_guard() {
    let (root, project) = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    transcript(&root, &id, &project);
    let mut policy = load(&root, &id, &project).unwrap();
    policy.configured_percent = Some(60);
    policy.configured_effort = Some(ClaudeEffort::Max);
    settings_store::update(&path_for(&root, &id).unwrap(), &serde_json::to_value(policy).unwrap(), None).unwrap();
    let mut cmd = Command::new("not-executed-fixture");
    cmd.arg("--resume").arg(&id);
    let prepared = prepare_for_root(&mut cmd, project.to_str().unwrap(), &root, None).unwrap();
    let args: Vec<_> = cmd.as_std().get_args().map(|value| value.to_string_lossy().to_string()).collect();
    assert_eq!(args.iter().filter(|arg| *arg == "--effort").count(), 1);
    assert_eq!(args.windows(2).find(|pair| pair[0] == "--effort").unwrap()[1], "max");
    assert_eq!(settings_overlay(&cmd), json!({"env": {
        "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "60", "CLAUDE_CODE_EFFORT_LEVEL": "max"}}));
    assert_eq!(prepared.session_id, id);
    assert!(shared_lease(&root, &prepared.key).is_err());
}

#[test]
fn separate_policy_updates_preserve_the_other_control_and_running_effort() {
    let (root, project) = fixture();
    let mut running = Command::new("not-executed-fixture");
    let prepared = prepare_for_root(&mut running, project.to_str().unwrap(), &root, Some(ClaudeEffort::Max.into())).unwrap();
    let id = prepared.session_id.clone();
    let stale = load(&root, &id, &project).unwrap();
    save_policy_field(&root, &stale, "configured_percent", json!(60)).unwrap();
    save_policy_field(&root, &stale, "configured_effort", json!("low")).unwrap();
    let updated = load(&root, &id, &project).unwrap();
    assert_eq!(updated.configured_percent, Some(60));
    assert_eq!(updated.configured_effort, Some(ClaudeEffort::Low));
    assert_eq!(updated.observation.applied_effort, Some(ClaudeEffort::Max));
    assert!(updated.observation.active);
    let args: Vec<_> = running.as_std().get_args().map(|value| value.to_string_lossy().to_string()).collect();
    assert_eq!(args.windows(2).find(|pair| pair[0] == "--effort").unwrap()[1], "max");
    drop(prepared);
    transcript(&root, &id, &project);
    let mut resumed = Command::new("not-executed-fixture");
    resumed.arg("--resume").arg(&id);
    let _next = prepare_for_root(&mut resumed, project.to_str().unwrap(), &root, None).unwrap();
    assert_eq!(load(&root, &id, &project).unwrap().observation.applied_effort, Some(ClaudeEffort::Low));
}

#[test]
fn clearing_session_effort_preserves_native_threshold_and_defaults() {
    let (root, project) = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    transcript(&root, &id, &project);
    let mut policy = load(&root, &id, &project).unwrap();
    policy.configured_percent = Some(60);
    policy.configured_effort = Some(ClaudeEffort::Max);
    settings_store::update(&path_for(&root, &id).unwrap(), &serde_json::to_value(&policy).unwrap(), None).unwrap();
    save_policy_field(&root, &policy, "configured_effort", Value::Null).unwrap();
    let mut cmd = Command::new("not-executed-fixture");
    cmd.arg("--resume").arg(&id).env("CLAUDE_CODE_EFFORT_LEVEL", "medium");
    let _prepared = prepare_for_root(&mut cmd, project.to_str().unwrap(), &root, None).unwrap();
    assert!(!cmd.as_std().get_args().any(|arg| arg == "--effort"));
    assert_eq!(cmd.as_std().get_envs().find(|(name, _)| *name == "CLAUDE_CODE_EFFORT_LEVEL").unwrap().1.unwrap(), "medium");
    assert_eq!(settings_overlay(&cmd)["env"]["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"], "60");
}

#[test]
fn session_effort_does_not_duplicate_a_caller_effort_argument() {
    let (root, project) = fixture();
    for flag in ["--effort", "--effort=low"] {
        let mut cmd = Command::new("not-executed-fixture");
        cmd.arg(flag);
        assert!(prepare_for_root(&mut cmd, project.to_str().unwrap(), &root, Some(ClaudeEffort::Max.into())).is_err());
    }
}

#[test]
fn explicit_inherit_request_clears_a_later_saved_effort_but_keeps_sixty() {
    let (root, project) = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    transcript(&root, &id, &project);
    let mut policy = load(&root, &id, &project).unwrap();
    policy.configured_percent = Some(60);
    policy.configured_effort = Some(ClaudeEffort::Max);
    settings_store::update(&path_for(&root, &id).unwrap(), &serde_json::to_value(policy).unwrap(), None).unwrap();
    let choice: ClaudeEffortOverride = serde_json::from_value(json!({"level": null})).unwrap();
    let mut cmd = Command::new("not-executed-fixture");
    cmd.arg("--resume").arg(&id).env("CLAUDE_CODE_EFFORT_LEVEL", "medium");
    let _prepared = prepare_for_root(&mut cmd, project.to_str().unwrap(), &root, Some(choice)).unwrap();
    assert!(!cmd.as_std().get_args().any(|arg| arg == "--effort"));
    let policy = load(&root, &id, &project).unwrap();
    assert_eq!(policy.configured_effort, None);
    assert_eq!(policy.configured_percent, Some(60));
}

#[test]
#[ignore = "Explicit cross-client process contract only; fixtures and lock files are retained"]
fn guard_contract_process() {
    let root = PathBuf::from(std::env::var_os("CLAUDE_GUARD_CONTRACT_ROOT").expect("isolated root required"));
    let id = std::env::var("CLAUDE_GUARD_CONTRACT_ID").expect("fixture UUID required");
    let mode = std::env::var("CLAUDE_GUARD_CONTRACT_MODE").expect("contract mode required");
    let key = key_for_root(&canonical_identity(&root).unwrap(), &id).unwrap();
    match shared_lease(&root, &key) {
        Ok(_lease) => {
            println!("CONTRACT_ACQUIRED={key}");
            if mode == "hold" {
                fs::write(root.join("ready-anycode.txt"), &key).unwrap();
                let end = std::time::Instant::now() + std::time::Duration::from_secs(30);
                while !root.join("release-anycode.txt").is_file() && std::time::Instant::now() < end {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                assert!(root.join("release-anycode.txt").is_file(), "release signal timed out");
            }
        }
        Err(_) => println!("CONTRACT_BUSY={key}"),
    }
}
