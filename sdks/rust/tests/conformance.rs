use crosslink_sdk::{canonical_json, encode_frame, FrameDecoder, DEFAULT_MAX_FRAME_BYTES};
use serde_json::json;

#[test]
fn canonical_request_and_fragmented_frame() {
    let request = json!({
        "v": "1.0", "t": "req", "i": "AAAAAAAAAAAAAAAA", "m": "echo",
        "p": { "hello": "world", "n": 42 }
    });
    assert_eq!(canonical_json(&request).unwrap(), "{\"i\":\"AAAAAAAAAAAAAAAA\",\"m\":\"echo\",\"p\":{\"hello\":\"world\",\"n\":42},\"t\":\"req\",\"v\":\"1.0\"}");
    let frame = encode_frame(&request, DEFAULT_MAX_FRAME_BYTES).unwrap();
    let mut decoder = FrameDecoder::default();
    assert!(decoder.push(&frame[..3]).unwrap().is_empty());
    assert_eq!(decoder.push(&frame[3..]).unwrap(), vec![request]);
}
