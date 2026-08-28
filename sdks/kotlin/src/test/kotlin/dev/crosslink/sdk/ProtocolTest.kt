package dev.crosslink.sdk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ProtocolTest {
    @Test fun canonicalRequestAndFragmentedFrame() {
        val request = CrosslinkValue.ObjectValue(mapOf(
            "v" to CrosslinkValue.StringValue("1.0"),
            "t" to CrosslinkValue.StringValue("req"),
            "i" to CrosslinkValue.StringValue("AAAAAAAAAAAAAAAA"),
            "m" to CrosslinkValue.StringValue("echo"),
            "p" to CrosslinkValue.ObjectValue(mapOf(
                "hello" to CrosslinkValue.StringValue("world"),
                "n" to CrosslinkValue.Number(42)
            ))
        ))
        val canonical = CrosslinkProtocol.canonicalJson(request)
        assertEquals("{\"i\":\"AAAAAAAAAAAAAAAA\",\"m\":\"echo\",\"p\":{\"hello\":\"world\",\"n\":42},\"t\":\"req\",\"v\":\"1.0\"}", canonical)
        val frame = CrosslinkProtocol.encodeFrame(request)
        val decoder = CrosslinkFrameDecoder()
        assertTrue(decoder.push(frame.copyOfRange(0, 3)).isEmpty())
        assertEquals(listOf(canonical), decoder.push(frame.copyOfRange(3, frame.size)))
    }
}
