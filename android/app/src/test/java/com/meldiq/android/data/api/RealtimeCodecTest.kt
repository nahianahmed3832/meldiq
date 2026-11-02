package com.meldiq.android.data.api

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

/**
 * [RealtimeCodec] against the server's WebSocket contract (docs/api/realtime.schema.json, generated from
 * server/src/shared/contracts/realtime.ts): every frame the server can send has a typed event here, and every frame the
 * app sends is one the server accepts. The captured frames themselves are decoded in ContractFixturesTest.
 */
class RealtimeCodecTest {
    private val schema: JsonObject = generateSequence(File("").absoluteFile) { it.parentFile }
        .map { File(it, "docs/api/realtime.schema.json") }
        .firstOrNull { it.isFile }
        ?.let { Json.parseToJsonElement(it.readText()).jsonObject }
        ?: error("docs/api/realtime.schema.json not found above ${File("").absolutePath}")

    private fun variants(union: String): List<JsonObject> =
        schema.getValue("\$defs").jsonObject.getValue(union).jsonObject.let { (it["oneOf"] ?: it.getValue("anyOf")).jsonArray.flatMap(::flatten) }

    private fun flatten(e: JsonElement): List<JsonObject> {
        val o = e.jsonObject
        return (o["oneOf"] ?: o["anyOf"])?.jsonArray?.flatMap(::flatten) ?: listOf(o)
    }

    private fun typeOf(variant: JsonObject): String =
        variant.getValue("properties").jsonObject.getValue("t").jsonObject.getValue("const").jsonPrimitive.content

    @Test
    fun `every frame the server can send has a typed event`() {
        val serverTypes = variants("ServerEvent").map(::typeOf).toSet()
        assertEquals("server frames the app has no ServerEvent for", emptySet<String>(), serverTypes - RealtimeCodec.knownTypes)
        assertEquals("ServerEvents for frames the server no longer sends", emptySet<String>(), RealtimeCodec.knownTypes - serverTypes)
    }

    @Test
    fun `every frame the app sends matches the server's ClientEvent schema`() {
        val sent = listOf(ClientEvent.Ping, ClientEvent.Ack(listOf(1L, 2L), backlog = true), ClientEvent.Ack(emptyList(), false), ClientEvent.Typing("c_1", true))
        val accepted = variants("ClientEvent").associateBy(::typeOf)
        for (event in sent) {
            val frame = Json.parseToJsonElement(RealtimeCodec.encode(event)).jsonObject
            val t = frame.getValue("t").jsonPrimitive.content
            val variant = accepted[t] ?: error("the server doesn't accept \"$t\"")
            val props = variant.getValue("properties").jsonObject
            val required = variant.getValue("required").jsonArray.map { it.jsonPrimitive.content }
            assertEquals("$t: fields the server doesn't accept", emptySet<String>(), frame.keys - props.keys)
            assertTrue("$t: missing required ${required - frame.keys}", frame.keys.containsAll(required))
            for ((k, v) in frame) assertTrue("$t.$k has the wrong type: $v", matches(props.getValue(k).jsonObject, v))
        }
    }

    private fun matches(prop: JsonObject, v: JsonElement): Boolean = when (prop["type"]?.jsonPrimitive?.content) {
        "string" -> v is JsonPrimitive && v.isString
        "boolean" -> v is JsonPrimitive && !v.isString && v.booleanOrNull != null
        "integer" -> v is JsonPrimitive && !v.isString && v.longOrNull != null
        "array" -> v is JsonArray && v.all { matches(prop.getValue("items").jsonObject, it) }
        else -> true
    }

    @Test
    fun `outbound frames are built by the serializer, ids escaped`() {
        assertEquals("""{"t":"ping"}""", RealtimeCodec.encode(ClientEvent.Ping))
        assertEquals("""{"t":"ack","ids":[3,4],"backlog":false}""", RealtimeCodec.encode(ClientEvent.Ack(listOf(3, 4), false)))
        // The old string template interpolated the id as is: a quote would have broken the frame.
        val typing = Json.parseToJsonElement(RealtimeCodec.encode(ClientEvent.Typing("c\"x", false))).jsonObject
        assertEquals("c\"x", typing.getValue("c").jsonPrimitive.content)
    }

    @Test
    fun `an unknown frame type is ignored, not an error`() {
        assertEquals(ServerEvent.Unknown("ai.task.progress"), RealtimeCodec.decode("""{"t":"ai.task.progress","id":"x"}"""))
    }

    @Test
    fun `unknown fields on a known frame are ignored`() {
        val e = RealtimeCodec.decode("""{"t":"conv.updated","conversationId":"c_1","future":{"a":1}}""")
        assertEquals(ServerEvent.ConvUpdated("c_1"), e)
    }

    @Test
    fun `a profile change names whose profile to fetch again`() {
        assertEquals(ServerEvent.UserUpdated("u_1"), RealtimeCodec.decode("""{"t":"user.updated","userId":"u_1"}"""))
    }

    @Test
    fun `fieldless frames decode to their objects`() {
        assertEquals(ServerEvent.QueueDrained, RealtimeCodec.decode("""{"t":"queue.drained"}"""))
        assertEquals(ServerEvent.ConnectionsUpdated, RealtimeCodec.decode("""{"t":"connections.updated"}"""))
    }

    @Test
    fun `fields older servers leave out keep the old defaults`() {
        assertEquals(ServerEvent.Typing("c", "u", on = false), RealtimeCodec.decode("""{"t":"typing","c":"c","u":"u"}"""))
        assertEquals(ServerEvent.Presence("u", online = true), RealtimeCodec.decode("""{"t":"presence","userId":"u","online":true}"""))
        assertEquals(ServerEvent.Queue(), RealtimeCodec.decode("""{"t":"queue"}"""))
    }

    @Test
    fun `a live queue frame carries its items, a backlog one says so`() {
        val text = """{"t":"queue","more":true,"items":[{"id":7,"kind":"envelope","conversationId":"c","messageId":"m",
            "senderUserId":"u","senderDeviceId":"d","createdAt":1,"expiresAt":2,"payload":{"v":1,"cls":"message","nonce":"n"}}]}"""
        val q = RealtimeCodec.decode(text) as ServerEvent.Queue
        assertEquals(7L, q.items.single().id)
        assertEquals("message", q.items.single().payload.cls)
        assertEquals(false, q.backlog)
        assertEquals(true, (RealtimeCodec.decode("""{"t":"queue","items":[],"more":false,"backlog":true}""") as ServerEvent.Queue).backlog)
    }

    @Test
    fun `a call frame keeps its event name and extras`() {
        val call = """{"id":"k","conversationId":"c","createdBy":"u","video":false,"state":"ENDED","createdAt":1}"""
        val declined = RealtimeCodec.decode("""{"t":"call","event":"declined","call":$call,"userId":"u2","reason":"busy"}""") as ServerEvent.Call
        assertEquals(CallEvents.DECLINED, declined.event)
        assertEquals("busy", declined.reason)
        val moderated = RealtimeCodec.decode("""{"t":"call","event":"moderated","action":"mute","call":$call}""") as ServerEvent.Call
        assertEquals("mute", moderated.action)
        val ring = RealtimeCodec.decode("""{"t":"call","event":"ring","call":$call,"from":{"userId":"u","displayName":"Bob"}}""") as ServerEvent.Call
        assertEquals("Bob", ring.from?.displayName)
    }

    @Test
    fun `broken frames are reported as malformed`() {
        for (text in listOf("not json", "[]", """{"no":"type"}""", """{"t":"call","event":"ring"}""", """{"t":"conv.updated"}""")) {
            try {
                RealtimeCodec.decode(text)
                fail("decoded $text")
            } catch (_: MalformedFrame) {
            }
        }
    }
}
