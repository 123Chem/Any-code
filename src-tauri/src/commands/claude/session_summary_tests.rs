//! Offline summary fixtures; no real Claude configuration or history is read.

use super::*;
use std::cell::Cell;
use std::io::{Cursor, Write};
use std::rc::Rc;

fn summary(bytes: &[u8], capacity: usize) -> (Option<String>, Option<String>) {
    scan(&mut BufReader::with_capacity(capacity, bytes))
}

#[test]
fn latest_metadata_and_top_level_model_precedence_are_preserved() {
    let rows = br#"{"type":"system","model":"init-model","timestamp":"not-a-message"}
{"message":{"role":"assistant","model":"nested-model"},"model":"top-model","timestamp":"t1"}
{"message":{"model":"fallback-model"},"model":null,"timestamp":"t2"}
{"message":{},"timestamp":"t3"}
"#;
    assert_eq!(summary(rows, 8192), (Some("t3".into()), Some("fallback-model".into())));
}

#[test]
fn malformed_rows_and_a_partial_tail_do_not_replace_valid_metadata() {
    let rows = br#"not-json
{"timestamp":"t1","message":{"model":"first"}}
{"timestamp":"bad","message":{"model":"bad"} BROKEN}
{"timestamp":"bad","message":{"model":"bad"}} trailing-junk
{"timestamp":"t2","message":{"model":"last"}}
{"timestamp":"partial","message":{"model":"partial"}
"#;
    assert_eq!(summary(rows, 7), (Some("t2".into()), Some("last".into())));
}

#[test]
fn numeric_or_duplicate_typed_fields_do_not_hide_an_otherwise_valid_model() {
    let rows = br#"{"timestamp":"t1","message":{"role":"user"}}
{"type":42,"timestamp":"bad","message":{"model":"kind-model"}}
{"timestamp":9,"message":{"model":"time-model"}}
{"timestamp":"bad","message":{"role":false,"model":"role-model"}}
{"timestamp":"bad","timestamp":"also-bad","message":{},"model":"duplicate-model"}
"#;
    assert_eq!(summary(rows, 11), (Some("t1".into()), Some("duplicate-model".into())));
}

#[test]
fn nested_body_metadata_and_non_object_messages_are_not_guessed() {
    let rows = br#"{"timestamp":"t1","message":{"model":"real-model"}}
{"timestamp":"not-a-message","message":false,"model":null}
{"message":{"content":[{"type":"text","text":"model: fake-model; timestamp: fake-time"}]},"payload":{"model":"fake-model","timestamp":"fake-time"}}
"#;
    assert_eq!(summary(rows, 5), (Some("t1".into()), Some("real-model".into())));
}

#[test]
fn records_and_escape_sequences_crossing_small_buffers_remain_independent() {
    let rows = [
        b"\n".as_slice(),
        br#"{"message":{"model":"initial"},"timestamp":"t1"}"#.as_slice(),
        b"\r\n".as_slice(),
        br#"{"unknown":"quotes: \"; slash: \\; newline: \n","message":{"model":"late"},"timestamp":"t2"}"#.as_slice(),
        b"\n".as_slice(),
        br#"{"model":"final-without-newline"}"#.as_slice(),
    ].concat();
    for capacity in [1, 2, 3, 7, 17, 8192] {
        assert_eq!(summary(&rows, capacity), (Some("t2".into()), Some("final-without-newline".into())));
    }
}

#[test]
fn a_large_inline_image_is_skipped_and_metadata_after_it_is_read() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("large-image.jsonl");
    let mut file = File::create(&path).unwrap();
    file.write_all(br#"{"type":"assistant","message":{"content":[{"type":"image","source":{"type":"base64","data":""#).unwrap();
    io::copy(&mut io::repeat(b'A').take(8 * 1024 * 1024), &mut file).unwrap();
    file.write_all(br#""}}],"model":"after-image"},"timestamp":"t-image"}
{"message":{"model":"last"},"timestamp":"t-last"}
"#).unwrap();
    drop(file);
    assert_eq!(extract(&path), (Some("t-last".into()), Some("last".into())));
    let mut reader = BufReader::with_capacity(8192, File::open(&path).unwrap());
    let mut first = JsonLine { source: &mut reader, finished: false, utf8: Utf8State::default() };
    let first_metadata: LineMetadata = serde_json::from_reader(&mut first).unwrap();
    assert_eq!(first_metadata.model.or(first_metadata.message.model), Some("after-image".into()));
    assert_eq!(first_metadata.timestamp.as_deref(), Some("t-image"));
}

struct CountedRead {
    source: Cursor<Vec<u8>>,
    consumed: Rc<Cell<usize>>,
}

impl Read for CountedRead {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let count = self.source.read(output)?;
        self.consumed.set(self.consumed.get() + count);
        Ok(count)
    }
}

#[test]
fn both_summary_values_require_only_one_forward_read_of_the_source() {
    let rows = br#"{"timestamp":"first","message":{"model":"old"}}
broken row
{"message":{"model":"new"},"timestamp":"last"}
"#.to_vec();
    let expected_bytes = rows.len();
    let consumed = Rc::new(Cell::new(0));
    let source = CountedRead { source: Cursor::new(rows), consumed: consumed.clone() };
    let result = scan(&mut BufReader::with_capacity(13, source));
    assert_eq!(result, (Some("last".into()), Some("new".into())));
    assert_eq!(consumed.get(), expected_bytes);
}

#[test]
fn an_unavailable_history_file_still_returns_no_summary() {
    let directory = tempfile::tempdir().unwrap();
    assert_eq!(extract(&directory.path().join("missing.jsonl")), (None, None));
}

#[test]
fn invalid_utf8_in_ignored_payload_is_skipped_and_valid_multibyte_fields_cross_buffers() {
    let invalid = [
        b"{\"timestamp\":\"bad\",\"message\":{\"content\":\"".as_slice(),
        &[0xff],
        b"\",\"model\":\"bad-model\"}}\n".as_slice(),
        r#"{"message":{"model":"晚到模型"},"timestamp":"时间二"}"#.as_bytes(),
    ].concat();
    for capacity in [1, 2, 3, 7, 8192] {
        assert_eq!(summary(&invalid, capacity), (Some("时间二".into()), Some("晚到模型".into())));
    }
    for sequence in [&[0xc0, 0x80][..], &[0xed, 0xa0, 0x80], &[0xf4, 0x90, 0x80, 0x80], &[0xe2]] {
        let mut state = Utf8State::default();
        state.observe(sequence);
        assert!(!state.complete());
    }
}
