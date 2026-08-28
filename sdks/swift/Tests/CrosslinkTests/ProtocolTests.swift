import XCTest
@testable import Crosslink

final class ProtocolTests: XCTestCase {
    func testCanonicalRequestAndFragmentedFrame() throws {
        let request: [String: Any] = [
            "v": "1.0", "t": "req", "i": "AAAAAAAAAAAAAAAA", "m": "echo",
            "p": ["hello": "world", "n": 42]
        ]
        let canonical = try CrosslinkProtocol.canonicalJSON(request)
        XCTAssertEqual(canonical, "{\"i\":\"AAAAAAAAAAAAAAAA\",\"m\":\"echo\",\"p\":{\"hello\":\"world\",\"n\":42},\"t\":\"req\",\"v\":\"1.0\"}")
        let frame = try CrosslinkProtocol.encodeFrame(request)
        var decoder = CrosslinkFrameDecoder()
        XCTAssertTrue(try decoder.push(frame.prefix(3)).isEmpty)
        let decoded = try decoder.push(frame.dropFirst(3))
        XCTAssertEqual(decoded.first?["t"] as? String, "req")
    }
}
