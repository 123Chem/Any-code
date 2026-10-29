//! Extract top-level ownership before a large inline image or message payload.

use serde::de::{self, IgnoredAny, MapAccess, Visitor};
use serde::Deserializer;
use serde_json::Value;

#[derive(Default, Debug)]
pub struct SessionMetadata {
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub kind: Option<String>,
    pub sidechain: Option<bool>,
}

struct MetadataVisitor<'a>(&'a mut SessionMetadata);

impl<'de> Visitor<'de> for MetadataVisitor<'_> {
    type Value = ();

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("session metadata object")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "sessionId" => self.0.session_id = map.next_value()?,
                "cwd" => self.0.cwd = map.next_value()?,
                "type" => self.0.kind = map.next_value()?,
                "isSidechain" => self.0.sidechain = map.next_value()?,
                _ => { map.next_value::<IgnoredAny>()?; }
            }
            if self.0.session_id.is_some() && self.0.cwd.is_some()
                && self.0.kind.is_some() && self.0.sidechain.is_some() {
                // Ownership is captured; do not allocate or consume the large message.
                return Err(de::Error::custom("metadata captured"));
            }
        }
        Ok(())
    }
}

pub fn extract(bytes: &[u8]) -> Option<SessionMetadata> {
    let mut metadata = SessionMetadata::default();
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    let _ = decoder.deserialize_map(MetadataVisitor(&mut metadata));
    if metadata.sidechain.is_none() {
        // Older small records may omit isSidechain; only accept complete JSON here.
        if let Ok(value) = serde_json::from_slice::<Value>(bytes) {
            metadata.session_id = value.get("sessionId").and_then(Value::as_str).map(str::to_owned);
            metadata.cwd = value.get("cwd").and_then(Value::as_str).map(str::to_owned);
            metadata.kind = value.get("type").and_then(Value::as_str).map(str::to_owned);
            metadata.sidechain = Some(value.get("isSidechain").and_then(Value::as_bool).unwrap_or(false));
        }
    }
    if metadata.sidechain != Some(false) || metadata.session_id.is_none() || metadata.cwd.is_none()
        || !matches!(metadata.kind.as_deref(), Some("user" | "assistant")) {
        return None;
    }
    Some(metadata)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ownership_before_large_image_does_not_require_the_full_line() {
        let prefix = br#"{"sessionId":"real","cwd":"D:\\project","type":"user","isSidechain":false,"message":{"image":""#;
        let mut line = prefix.to_vec();
        line.extend(vec![b'x'; 100000]);
        let metadata = extract(&line[..65536]).unwrap();
        assert_eq!(metadata.session_id.as_deref(), Some("real"));
        assert_eq!(metadata.cwd.as_deref(), Some("D:\\project"));
    }

    #[test]
    fn embedded_fake_metadata_and_sidechain_are_not_adopted() {
        assert!(extract(br#"{"message":{"sessionId":"fake","cwd":"D:/other","type":"user"}}"#).is_none());
        assert!(extract(br#"{"sessionId":"real","cwd":"D:/project","type":"user","isSidechain":true}"#).is_none());
    }

    #[test]
    fn complete_legacy_records_without_sidechain_remain_supported() {
        assert!(extract(br#"{"sessionId":"real","cwd":"D:/project","type":"assistant"}"#).is_some());
    }
}
