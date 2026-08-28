package dev.crosslink.sdk

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

sealed interface CrosslinkValue {
    data object Null : CrosslinkValue
    data class Bool(val value: Boolean) : CrosslinkValue
    data class Number(val value: kotlin.Number) : CrosslinkValue
    data class StringValue(val value: String) : CrosslinkValue
    data class ArrayValue(val value: List<CrosslinkValue>) : CrosslinkValue
    data class ObjectValue(val value: Map<String, CrosslinkValue>) : CrosslinkValue
}

object CrosslinkProtocol {
    const val VERSION = "1.0"
    const val DEFAULT_MAX_FRAME_BYTES = 1_048_576

    fun canonicalJson(value: CrosslinkValue): String = when (value) {
        CrosslinkValue.Null -> "null"
        is CrosslinkValue.Bool -> value.value.toString()
        is CrosslinkValue.Number -> {
            val double = value.value.toDouble()
            require(double.isFinite()) { "non-finite number" }
            value.value.toString()
        }
        is CrosslinkValue.StringValue -> quote(value.value)
        is CrosslinkValue.ArrayValue -> value.value.joinToString(",", "[", "]", transform = ::canonicalJson)
        is CrosslinkValue.ObjectValue -> value.value.keys.sorted().joinToString(",", "{", "}") { key ->
            "${quote(key)}:${canonicalJson(value.value.getValue(key))}"
        }
    }

    fun encodeFrame(value: CrosslinkValue.ObjectValue, maxBytes: Int = DEFAULT_MAX_FRAME_BYTES): ByteArray {
        val payload = canonicalJson(value).toByteArray(Charsets.UTF_8)
        require(payload.size <= maxBytes) { "frame too large" }
        return ByteBuffer.allocate(4 + payload.size).order(ByteOrder.BIG_ENDIAN)
            .putInt(payload.size).put(payload).array()
    }

    private fun quote(value: String): String = buildString {
        append('"')
        value.forEach { char ->
            when (char) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\b' -> append("\\b")
                '\u000C' -> append("\\f")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (char.code < 0x20) append("\\u%04x".format(char.code)) else append(char)
            }
        }
        append('"')
    }
}

class CrosslinkFrameDecoder(private val maxBytes: Int = CrosslinkProtocol.DEFAULT_MAX_FRAME_BYTES) {
    private val buffer = ByteArrayOutputStream()

    fun push(chunk: ByteArray): List<String> {
        buffer.write(chunk)
        var bytes = buffer.toByteArray()
        val messages = mutableListOf<String>()
        while (bytes.size >= 4) {
            val length = ByteBuffer.wrap(bytes, 0, 4).order(ByteOrder.BIG_ENDIAN).int
            require(length in 0..maxBytes) { "frame too large" }
            if (bytes.size < 4 + length) break
            messages += bytes.copyOfRange(4, 4 + length).toString(Charsets.UTF_8)
            bytes = bytes.copyOfRange(4 + length, bytes.size)
        }
        buffer.reset()
        buffer.write(bytes)
        return messages
    }
}
