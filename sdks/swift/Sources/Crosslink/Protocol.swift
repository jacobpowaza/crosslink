import Foundation
import CoreFoundation

public enum CrosslinkProtocolError: Error, Equatable {
    case unsupportedValue
    case invalidUTF8
    case invalidJSON
    case frameTooLarge
}

public enum CrosslinkProtocol {
    public static let version = "1.0"
    public static let defaultMaxFrameBytes = 1_048_576

    public static func canonicalJSON(_ value: Any) throws -> String {
        if value is NSNull { return "null" }
        if let value = value as? String {
            let data = try JSONSerialization.data(withJSONObject: [value])
            let encoded = String(decoding: data, as: UTF8.self)
            return String(encoded.dropFirst().dropLast())
        }
        if let value = value as? NSNumber {
            if CFGetTypeID(value) == CFBooleanGetTypeID() { return value.boolValue ? "true" : "false" }
            guard value.doubleValue.isFinite else { throw CrosslinkProtocolError.unsupportedValue }
            return value.stringValue
        }
        if let array = value as? [Any] {
            return "[" + (try array.map(canonicalJSON)).joined(separator: ",") + "]"
        }
        if let object = value as? [String: Any] {
            return "{" + (try object.keys.sorted().map { key in
                try canonicalJSON(key) + ":" + canonicalJSON(object[key]!)
            }).joined(separator: ",") + "}"
        }
        throw CrosslinkProtocolError.unsupportedValue
    }

    public static func encodeMessage(_ object: [String: Any]) throws -> Data {
        Data(try canonicalJSON(object).utf8)
    }

    public static func encodeFrame(
        _ object: [String: Any],
        maxFrameBytes: Int = defaultMaxFrameBytes
    ) throws -> Data {
        let payload = try encodeMessage(object)
        guard payload.count <= maxFrameBytes else { throw CrosslinkProtocolError.frameTooLarge }
        var length = UInt32(payload.count).bigEndian
        var frame = Data(bytes: &length, count: MemoryLayout<UInt32>.size)
        frame.append(payload)
        return frame
    }
}

public struct CrosslinkFrameDecoder {
    private var buffer = Data()
    private let maxFrameBytes: Int

    public init(maxFrameBytes: Int = CrosslinkProtocol.defaultMaxFrameBytes) {
        self.maxFrameBytes = maxFrameBytes
    }

    public mutating func push(_ chunk: Data) throws -> [[String: Any]] {
        buffer.append(chunk)
        var messages: [[String: Any]] = []
        while buffer.count >= 4 {
            let length = buffer.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
            guard length <= maxFrameBytes else { throw CrosslinkProtocolError.frameTooLarge }
            let end = 4 + Int(length)
            guard buffer.count >= end else { break }
            let payload = buffer.subdata(in: 4..<end)
            guard let object = try JSONSerialization.jsonObject(with: payload) as? [String: Any]
            else { throw CrosslinkProtocolError.invalidJSON }
            messages.append(object)
            buffer.removeSubrange(0..<end)
        }
        return messages
    }
}
