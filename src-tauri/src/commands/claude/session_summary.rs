//! Stream list metadata once; unknown payloads and large images are never materialized.

use serde::de::{IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read};
use std::path::Path;

#[derive(Default)]
struct StringField {
    value: Option<String>,
    compatible: bool,
}

struct StringFieldVisitor;

impl<'de> Visitor<'de> for StringFieldVisitor {
    type Value = StringField;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("metadata string or another ignored JSON value")
    }

    fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
        Ok(StringField { value: Some(value.to_owned()), compatible: true })
    }

    fn visit_string<E: serde::de::Error>(self, value: String) -> Result<Self::Value, E> {
        Ok(StringField { value: Some(value), compatible: true })
    }

    fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
        Ok(StringField { value: None, compatible: true })
    }

    fn visit_bool<E: serde::de::Error>(self, _value: bool) -> Result<Self::Value, E> { Ok(StringField::default()) }
    fn visit_i64<E: serde::de::Error>(self, _value: i64) -> Result<Self::Value, E> { Ok(StringField::default()) }
    fn visit_u64<E: serde::de::Error>(self, _value: u64) -> Result<Self::Value, E> { Ok(StringField::default()) }
    fn visit_f64<E: serde::de::Error>(self, _value: f64) -> Result<Self::Value, E> { Ok(StringField::default()) }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
        Ok(StringField::default())
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Self::Value, A::Error> {
        while sequence.next_element::<IgnoredAny>()?.is_some() {}
        Ok(StringField::default())
    }
}

impl<'de> Deserialize<'de> for StringField {
    fn deserialize<D: Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
        decoder.deserialize_any(StringFieldVisitor)
    }
}

#[derive(Default)]
struct MessageMetadata {
    model: Option<String>,
    is_object: bool,
    compatible: bool,
}

struct MessageVisitor;

impl<'de> Visitor<'de> for MessageVisitor {
    type Value = MessageMetadata;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("message metadata without its content payload")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut result = MessageMetadata { is_object: true, compatible: true, ..Default::default() };
        let (mut role_seen, mut content_seen) = (false, false);
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "model" => result.model = map.next_value::<StringField>()?.value,
                "role" => {
                    let role = map.next_value::<StringField>()?;
                    result.compatible &= !role_seen && role.compatible;
                    role_seen = true;
                }
                "content" => {
                    map.next_value::<IgnoredAny>()?;
                    result.compatible &= !content_seen;
                    content_seen = true;
                }
                _ => { map.next_value::<IgnoredAny>()?; }
            }
        }
        Ok(result)
    }

    fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
        Ok(MessageMetadata { compatible: true, ..Default::default() })
    }

    fn visit_str<E: serde::de::Error>(self, _value: &str) -> Result<Self::Value, E> { Ok(MessageMetadata::default()) }
    fn visit_bool<E: serde::de::Error>(self, _value: bool) -> Result<Self::Value, E> { Ok(MessageMetadata::default()) }
    fn visit_i64<E: serde::de::Error>(self, _value: i64) -> Result<Self::Value, E> { Ok(MessageMetadata::default()) }
    fn visit_u64<E: serde::de::Error>(self, _value: u64) -> Result<Self::Value, E> { Ok(MessageMetadata::default()) }
    fn visit_f64<E: serde::de::Error>(self, _value: f64) -> Result<Self::Value, E> { Ok(MessageMetadata::default()) }

    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Self::Value, A::Error> {
        while sequence.next_element::<IgnoredAny>()?.is_some() {}
        Ok(MessageMetadata::default())
    }
}

impl<'de> Deserialize<'de> for MessageMetadata {
    fn deserialize<D: Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
        decoder.deserialize_any(MessageVisitor)
    }
}

struct LineMetadata {
    timestamp: Option<String>,
    model: Option<String>,
    message: MessageMetadata,
    compatible: bool,
}

struct LineVisitor;

impl<'de> Visitor<'de> for LineVisitor {
    type Value = LineMetadata;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("top-level Claude JSONL metadata")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut result = LineMetadata { timestamp: None, model: None,
            message: MessageMetadata { compatible: true, ..Default::default() }, compatible: true };
        let (mut timestamp_seen, mut kind_seen, mut message_seen) = (false, false, false);
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "timestamp" => {
                    let timestamp = map.next_value::<StringField>()?;
                    result.compatible &= !timestamp_seen && timestamp.compatible;
                    result.timestamp = timestamp.value;
                    timestamp_seen = true;
                }
                "type" => {
                    let kind = map.next_value::<StringField>()?;
                    result.compatible &= !kind_seen && kind.compatible;
                    kind_seen = true;
                }
                "message" => {
                    result.message = map.next_value()?;
                    result.compatible &= !message_seen;
                    message_seen = true;
                }
                "model" => result.model = map.next_value::<StringField>()?.value,
                _ => { map.next_value::<IgnoredAny>()?; }
            }
        }
        Ok(result)
    }
}

impl<'de> Deserialize<'de> for LineMetadata {
    fn deserialize<D: Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
        decoder.deserialize_map(LineVisitor)
    }
}

/// Ignored JSON strings still need the UTF-8 validation previously done by lines().
#[derive(Default)]
struct Utf8State {
    remaining: u8,
    minimum: u8,
    maximum: u8,
    invalid: bool,
}

impl Utf8State {
    fn observe(&mut self, bytes: &[u8]) {
        if self.invalid { return; }
        for &byte in bytes {
            if self.remaining > 0 {
                if !(self.minimum..=self.maximum).contains(&byte) { self.invalid = true; return; }
                self.remaining -= 1;
                self.minimum = 0x80;
                self.maximum = 0xbf;
            } else {
                (self.remaining, self.minimum, self.maximum) = match byte {
                    0x00..=0x7f => continue,
                    0xc2..=0xdf => (1, 0x80, 0xbf),
                    0xe0 => (2, 0xa0, 0xbf),
                    0xe1..=0xec | 0xee..=0xef => (2, 0x80, 0xbf),
                    0xed => (2, 0x80, 0x9f),
                    0xf0 => (3, 0x90, 0xbf),
                    0xf1..=0xf3 => (3, 0x80, 0xbf),
                    0xf4 => (3, 0x80, 0x8f),
                    _ => { self.invalid = true; return; }
                };
            }
        }
    }

    fn complete(&self) -> bool { !self.invalid && self.remaining == 0 }
}

/// Serde sees EOF at this physical newline and cannot consume the next record.
struct JsonLine<'a, R> {
    source: &'a mut R,
    finished: bool,
    utf8: Utf8State,
}

impl<R: BufRead> Read for JsonLine<'_, R> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if self.finished || output.is_empty() { return Ok(0); }
        let available = self.source.fill_buf()?;
        if available.is_empty() { self.finished = true; return Ok(0); }
        let length = available.len().min(output.len());
        // Search only bytes being returned, even when serde asks for one byte.
        let newline = available[..length].iter().position(|byte| *byte == b'\n');
        let count = newline.unwrap_or(length);
        output[..count].copy_from_slice(&available[..count]);
        self.utf8.observe(&output[..count]);
        self.source.consume(count + if newline.is_some() { 1 } else { 0 });
        self.finished = newline.is_some();
        Ok(count)
    }
}

fn scan<R: BufRead>(reader: &mut R) -> (Option<String>, Option<String>) {
    let (mut last_timestamp, mut last_model) = (None, None);
    while reader.fill_buf().is_ok_and(|buffer| !buffer.is_empty()) {
        let mut line = JsonLine { source: reader, finished: false, utf8: Utf8State::default() };
        let metadata = serde_json::from_reader::<_, LineMetadata>(&mut line);
        // A malformed row may stop before its delimiter; drain it without an allocation.
        if io::copy(&mut line, &mut io::sink()).is_err() { break; }
        if !line.utf8.complete() { continue; }
        if let Ok(metadata) = metadata {
            if metadata.compatible && metadata.message.compatible && metadata.message.is_object {
                if let Some(timestamp) = metadata.timestamp { last_timestamp = Some(timestamp); }
            }
            if let Some(model) = metadata.model.or(metadata.message.model) { last_model = Some(model); }
        }
    }
    (last_timestamp, last_model)
}

pub(super) fn extract(path: &Path) -> (Option<String>, Option<String>) {
    let Ok(file) = File::open(path) else { return (None, None); };
    scan(&mut BufReader::with_capacity(8192, file))
}

#[cfg(test)]
#[path = "session_summary_tests.rs"]
mod tests;
