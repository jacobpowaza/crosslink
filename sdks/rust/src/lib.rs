use serde_json::Value;
use std::fmt::Write;

pub const PROTOCOL_VERSION: &str = "1.0";
pub const DEFAULT_MAX_FRAME_BYTES: usize = 1_048_576;

#[derive(Debug, PartialEq, Eq)]
pub enum ProtocolError {
    UnsupportedNumber,
    InvalidJson,
    FrameTooLarge,
}

pub fn canonical_json(value: &Value) -> Result<String, ProtocolError> {
    let mut output = String::new();
    write_canonical(value, &mut output)?;
    Ok(output)
}

fn write_canonical(value: &Value, output: &mut String) -> Result<(), ProtocolError> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => output.push_str(&value.to_string()),
        Value::String(value) => output.push_str(&serde_json::to_string(value).unwrap()),
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 { output.push(','); }
                write_canonical(value, output)?;
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push('{');
            let mut keys: Vec<_> = values.keys().collect();
            keys.sort();
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 { output.push(','); }
                write!(output, "{}:", serde_json::to_string(key).unwrap()).unwrap();
                write_canonical(&values[key], output)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

pub fn encode_frame(value: &Value, max_bytes: usize) -> Result<Vec<u8>, ProtocolError> {
    let payload = canonical_json(value)?.into_bytes();
    if payload.len() > max_bytes || payload.len() > u32::MAX as usize {
        return Err(ProtocolError::FrameTooLarge);
    }
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

pub struct FrameDecoder {
    buffer: Vec<u8>,
    max_bytes: usize,
}

impl FrameDecoder {
    pub fn new(max_bytes: usize) -> Self { Self { buffer: Vec::new(), max_bytes } }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Value>, ProtocolError> {
        self.buffer.extend_from_slice(chunk);
        let mut messages = Vec::new();
        loop {
            if self.buffer.len() < 4 { break; }
            let length = u32::from_be_bytes(self.buffer[0..4].try_into().unwrap()) as usize;
            if length > self.max_bytes { return Err(ProtocolError::FrameTooLarge); }
            if self.buffer.len() < 4 + length { break; }
            let value = serde_json::from_slice(&self.buffer[4..4 + length])
                .map_err(|_| ProtocolError::InvalidJson)?;
            messages.push(value);
            self.buffer.drain(0..4 + length);
        }
        Ok(messages)
    }
}

impl Default for FrameDecoder {
    fn default() -> Self { Self::new(DEFAULT_MAX_FRAME_BYTES) }
}
