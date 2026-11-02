package com.meldiq.android

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.material3.Text
import com.meldiq.android.call.MediaSecurity
import com.meldiq.android.data.api.ApiClient
import com.meldiq.android.data.api.CallRes
import com.meldiq.android.data.api.StartCallReq
import com.meldiq.android.data.repo.ProfileStorage
import com.meldiq.android.di.AppContainer
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.cancel
import com.meldiq.android.call.CallPhase
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.Rule
import org.junit.runner.RunWith
import java.util.UUID

/** Real repositories against a throwaway current API; the peer posts exactly the web client's v2 controls. */
@RunWith(AndroidJUnit4::class)
class CallControlInteropTest {
    @get:Rule val compose = createComposeRule()
    private lateinit var container: AppContainer
    private lateinit var fixture: ApiClient

    @Before fun setUp() = runBlocking {
        val args = InstrumentationRegistry.getArguments()
        val api = args.getString("interopApi")
        val peer = args.getString("interopFixture")
        assumeTrue("Needs the local call-interoperability fixture", api != null && peer != null)
        val app = ApplicationProvider.getApplicationContext<Application>()
        val name = "callinterop" + UUID.randomUUID().toString().replace("-", "").take(10)
        container = AppContainer(app, ProfileStorage.of(name), api!!)
        fixture = ApiClient({ peer!! }, { null }, { false })
        container.session.register(api, name, "Android call test", 0)
    }

    @After fun tearDown() { if (::container.isInitialized) container.close() }

    private suspend fun prepare(voice: Boolean = false): JsonObject {
        val result = fixture.post<JsonObject, JsonObject>("/prepare", buildJsonObject {
            put("userId", container.session.session!!.userId); put("voice", voice)
        })
        result["inviteCode"]?.jsonPrimitive?.contentOrNull?.let { code ->
            container.api.post<JsonObject, JsonObject>("/v1/invites/accept", buildJsonObject { put("code", code) })
        }
        return result
    }

    private suspend fun peer(path: String, id: String, callId: String? = null, media: Boolean = false): JsonObject =
        fixture.post<JsonObject, JsonObject>(path, buildJsonObject {
            put("id", id); callId?.let { put("callId", it) }; if (media) put("media", true)
        })

    @Test fun receivesWebVoiceCallAndMeetingKeys() = runBlocking {
        for (voice in listOf(false, true)) {
            val prepared = prepare(voice)
            val invite = peer("/invite", prepared.getValue("id").jsonPrimitive.content)
            container.messages.pollQueueOnce()
            assertEquals("The browser's key must be readable by Android", invite.getValue("key").jsonPrimitive.content,
                container.messages.callKey(invite.getValue("callId").jsonPrimitive.content))
        }
    }

    @Test fun sendsKeysAndAnswersWebRequestsWithoutAWebSocket() = runBlocking {
        // No background outbox or socket consumer: HTTP call setup must still deliver its controls.
        container.scope.coroutineContext.cancelChildren()
        val prepared = prepare()
        val id = prepared.getValue("id").jsonPrimitive.content
        val cid = prepared.getValue("conversationId").jsonPrimitive.content
        val call = container.api.post<StartCallReq, CallRes>("/v1/calls", StartCallReq(cid, false)).call
        val key = java.util.Base64.getEncoder().encodeToString(ByteArray(32) { it.toByte() })
        container.messages.sendCallKey(cid, call.id, false, key)
        fun assertInvite(result: JsonObject) {
            val invites = result.getValue("controls").jsonArray.map { it.jsonObject }.filter { it["type"]?.jsonPrimitive?.content == "call_invite" }
            assertTrue("Call key must be delivered when sendCallKey returns", invites.any {
                it["callId"]?.jsonPrimitive?.content == call.id && it["e2eeKey"]?.jsonPrimitive?.content == key
            })
        }
        assertInvite(peer("/received", id))
        peer("/request", id, call.id)
        container.messages.pollQueueOnce()
        assertInvite(peer("/received", id))
        assertTrue("Call controls must bypass the chat outbox", container.db.outbox().due(Long.MAX_VALUE).none {
            it.payloadJson.contains("call_invite") || it.payloadJson.contains("call_key_request")
        })
    }

    @Test fun connectsActualAndroidAndWebMediaForCallsAndMeetings() = runBlocking {
        assumeTrue("Needs the browser and LiveKit fixture", InstrumentationRegistry.getArguments().getString("interopMedia") == "true")
        compose.setContent { Text("Local call interoperability test") }
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        automation.grantRuntimePermission(BuildConfig.APPLICATION_ID, android.Manifest.permission.RECORD_AUDIO)
        automation.grantRuntimePermission(BuildConfig.APPLICATION_ID, android.Manifest.permission.CAMERA)
        for (voice in listOf(false, true)) {
            val prepared = prepare(voice)
            val id = prepared.getValue("id").jsonPrimitive.content
            val cid = prepared.getValue("conversationId").jsonPrimitive.content
            val invite = peer("/invite", id, media = true)
            try {
                // No WebSocket is required: CallManager's HTTP recovery must retrieve the web's queued key.
                if (voice) {
                    val sheet = CoroutineScope(SupervisorJob() + Dispatchers.Default)
                    sheet.launch { container.calls.join(cid, invite.getValue("callId").jsonPrimitive.content, true) }
                    withTimeout(10_000) { while (container.calls.state.value.phase == CallPhase.Idle) delay(10) }
                    sheet.cancel() // the meeting sheet closes while its HTTP join is in flight
                } else {
                    withTimeout(10_000) { while (container.calls.state.value.phase != CallPhase.Incoming) delay(10) }
                    withTimeout(60_000) { container.calls.accept() }
                }
                withTimeout(30_000) {
                    while (container.calls.state.value.security != MediaSecurity.E2eeActive) delay(250)
                }
                withTimeout(30_000) {
                    while (peer("/mediaState", id)["security"]?.jsonPrimitive?.content != "encrypted") delay(250)
                }
                assertEquals(invite.getValue("key").jsonPrimitive.content, container.messages.callKey(invite.getValue("callId").jsonPrimitive.content))
            } finally {
                container.calls.hangup()
                peer("/closeMedia", id)
                delay(4_000)
            }
        }
    }
}
