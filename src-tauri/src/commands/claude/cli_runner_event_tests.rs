//! Event identity contracts require no running CLI, authentication or network.

use super::global_event_payload;
use serde_json::json;

const FIRST: &str = "00000000-0000-4000-8000-000000000001";
const SECOND: &str = "00000000-0000-4000-8000-000000000002";

#[test]
fn a_tabless_worker_still_identifies_its_original_uuid_before_init() {
    assert_eq!(global_event_payload(&None, FIRST, "early stderr"),
        json!({"tab_id": null, "session_id": FIRST, "payload": "early stderr"}));
}

#[test]
fn normal_new_tab_events_keep_both_tab_and_original_uuid() {
    assert_eq!(global_event_payload(&Some("tab-one".into()), FIRST, "stdout"),
        json!({"tab_id": "tab-one", "session_id": FIRST, "payload": "stdout"}));
}

#[test]
fn concurrent_worker_completion_has_a_distinct_original_owner() {
    let first = global_event_payload(&None, FIRST, false);
    let second = global_event_payload(&None, SECOND, false);
    assert_ne!(first["session_id"], second["session_id"]);
    assert_eq!(first["payload"], false);
    assert_eq!(second["payload"], false);
}

#[test]
fn a_payload_cannot_replace_the_prepared_uuid_in_the_event_envelope() {
    let content = json!({"session_id": SECOND, "type": "assistant"}).to_string();
    let event = global_event_payload(&None, FIRST, &content);
    assert_eq!(event["session_id"], FIRST);
    assert_eq!(event["payload"], content);
}
