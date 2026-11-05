# Meldiq native bot clients — preview

These are first-party source clients for Meldiq's native bot API, not a vendor-compatible protocol or a published package. JavaScript uses Node.js22.4+ built-in fetch/WebSocket; Python3.10+ uses the standard library for HTTP and long polling. The API's generated contracts remain authoritative: `docs/api/openapi.json` and `docs/api/bot-gateway.schema.json`.

Check `/v1/server-info` for `bots`, `bot-permissions` and, on PostgreSQL, `bot-event-gateway`. The expanded API is a candidate until its release is approved. No bot code is hosted by Meldiq.

1. Make a bot in Settings → Developer and keep its token in your bot process's environment. The token is shown once; rotating it revokes the old credential and closes its gateway sessions.
2. Request the access your bot needs in Developer → the bot's Permissions. For event-driven text bots this normally includes Events and Read earlier messages.
3. A community manager adds the bot and approves its requested access in Community settings → Integrations → Permissions. New requests do not expand an existing approval automatically.
4. Give it only the native roles/channel access it needs. Approval does not grant native roles, bypass denials or confer owner/administrator powers. A scoped SDK request can still correctly receive403.

Existing text sends and slash commands retain their native baseline. Advanced administration, history, reactions and community event delivery need the corresponding approval. Rich messages and controls additionally require `messages.post` approval, labelled “Rich messages and controls” in the UI. Community voice has a scoped preview described below; complete platform/native qualification remains pending. Avatar/banner uploads use the existing native MIME, size, processing and storage policies.

Personal bot DMs require the `direct_messages` request and the recipient's explicit consent in the bot profile. Community approval and bot ownership cannot authorize outreach to another person. `sendDirect(userId,content,{messageId})` (JavaScript) and `send_direct(user_id,content,message_id=...)` (Python) use only an existing personal approval. Replies produce self-addressed `dm_message` ID events; read current content through `/v2/bot/conversations/:id/messages`. Revocation or a block stops sends, history and replay; unblocking does not restore approval. Changing the requested manifest requires fresh personal review. Renewed consent starts a fresh conversation; prior revoked history remains available to the person but inaccessible to the bot. These conversations support messages, not calls.

## JavaScript

Import `MeldiqBot` from `javascript/index.mjs`. No npm installation or third-party dependency is required. Configure `apiOrigin` with the direct authoritative API origin and `token` with the bot token; HTTPS is required except on loopback for local tests.

```js
import { MeldiqBot } from "./javascript/index.mjs";

const bot = new MeldiqBot({
  apiOrigin: process.env.MELDIQ_API_ORIGIN,
  token: process.env.MELDIQ_BOT_TOKEN,
});
const { bot: identity } = await bot.me();
const { communities } = await bot.communities();
// Generic native calls stay inside this API origin and /v2/bot/ namespace.
const page = await bot.request("GET", `/v2/bot/conversations/${channelId}/messages?limit=20`);
```

Use a stable caller-chosen `messageId` when retrying a text send. The SDK does not automatically retry mutations. `MeldiqBotError` exposes `status`, `code` and optional `retryAfterMs`; it does not retain a request, token or redirected URL. Requests have bounded timeouts and response budgets; paginate large responses.

`uploadAvatar(bytes)` accepts native GIF/WebP/short-clip input; pass `{ animated:false }` for a native still JPEG photo. `uploadBanner(bytes)` accepts the native JPEG/GIF/WebP banner formats. Servers validate the bytes and current limits; the client does not invent new quotas or transcode files.

### Durable gateway consumers

```js
const gateway = await bot.openGateway({
  cursor: previouslyCommittedCursor,
  onBatch: async (events, { signal }) => {
    for (const event of events) await handleOnceByEventId(event.id, event, signal);
  },
  onCursor: async (cursor) => saveCursorAfterSuccessfulHandling(cursor),
});
const end = await gateway.closed;
if (end.error) handleConnectionFailure(end.error, gateway.cursor);
```

Events contain IDs and bounded metadata. Read current message content through approved native history; deleted text, historic edit bodies and private protocol controls are not returned by bot history. Delivery is at least once: deduplicate by stable event ID, and persist a cursor only after its batch succeeds. A handler failure preserves the previous committed cursor. Heartbeat renewal is checkpointed behind already-received batches, so it cannot skip an unfinished handler. RPC replies are handled separately, allowing a handler to await `gateway.request("self")` without deadlocking its batch.

Gateway RPC is limited to `self`, `communities` and `events`. Use native HTTP for other operations. `setPresence` controls only this bot's gateway presence. No human device/session or user WebSocket grant is created. The client has bounded frame/consumer queues; handlers should use their abort signal for bounded external I/O.

Resume using the last committed opaque cursor after a network failure or service restart. Token/approval revocation requires current credentials and approval; the client does not silently reconnect with a revoked credential. Replay lasts seven days. An expired cursor is explicit410; decide whether to start a fresh feed and reconcile application state. Back up the API's private `DATA_DIR/bot-event-cursor.key` with its database for server recovery. The operator's bounded retention job runs even while bots are offline.

## Python

Import `MeldiqBot` and `MeldiqBotError` from `python/meldiq_bot.py`. `me`, `communities`, `events`, `send`, `set_commands`, `interactions`, `reply`, `upload_avatar`, `upload_banner` and generic native `request` mirror the HTTP operations. Python currently uses HTTP/long polling; the JavaScript client supplies the gateway implementation. Redirects are refused in both clients so an authorization header cannot be forwarded to another origin.

`examples/commands.mjs` and `examples/commands.py` run a small native slash-command bot on infrastructure you control. They register a command, long-poll leased interactions and send an ephemeral reply. They never automatically DM people or create a paid service.

## Interactive messages

On servers advertising `bot-components`, both `send` and `sendDirect` accept `embeds`, link `buttons` and interactive `components`. Python uses the same keyword arguments with `components_ttl_seconds` for JavaScript's `componentsTtlSeconds`. Normal membership, channel content rules and plan limits still apply. Personal messages also require current recipient consent.

```js
await bot.send(channelId, "Choose what to share with this helper.", {
  messageId: stableMessageId,
  componentsTtlSeconds: 3600,
  components: [
    { type: "button", customId: "confirm", label: "Confirm" },
    { type: "select", customId: "category", label: "Category", options: [
      { value: "question", label: "Question" }, { value: "feedback", label: "Feedback" },
    ] },
    { type: "form", customId: "note", label: "Send feedback", fields: [
      { id: "note", label: "Your feedback", style: "paragraph", maxLength: 500 },
    ] },
  ],
});
for (const interaction of (await bot.interactions()).interactions) {
  if (!interaction.component) continue; // Ordinary slash command.
  // component contains source messageId, customId, type and private values/fields.
  // Handle only known IDs. Do not log private inputs or treat them as executable code.
  await bot.reply(interaction.id, "Thank you. Your input was received.", { ephemeral: true });
}
```

Messages allow up to five uniquely named controls. A select has at most25 options; a form has at most five fields,1000 UTF-16 code units per field and4000 total. Controls expire after one hour by default (60seconds to24hours configurable); each submission has at most15minutes for a reply. Disabled/expired/deleted/inaccessible source controls refuse new submissions. Blocks withdraw pending inputs and unblocking does not restore them. Approval, native membership, history boundaries and recipient consent are rechecked before delivery and replies.

Component submissions use the existing leased interaction queue. The bot event journal emits an `interaction` ID notice, never the form values; fetch the private input through `interactions()`. Inputs are sent to the addressed bot and its developer. They are not community messages. Expired queue data is removed by a bounded maintenance job after a one-hour retention grace, including while the bot is offline. The browser retains unsent form fields only while that form is open. This is not a recording or a hosted-code feature.

Implementation references: [Node's native WebSocket client](https://github.com/nodejs/learn/blob/main/pages/getting-started/websocket.md), [Python urllib redirect handling](https://docs.python.org/3.11/library/urllib.request.html#urllib.request.HTTPRedirectHandler.redirect_request).

## Community voice preview

The default voice join targets an existing active, locally hosted community voice room. A compatible connected member supplies the room key. Servers advertising `bot-voice-wait-v1` also support an explicit waiting mode for an empty channel; personal bot DMs remain messages-only. Voice does not create recording, clips, soundboards or hosted execution.

Request `voice.connect` and, if needed, `voice.speak`. Approval does not grant native roles, bypass a voice ban/timeout or override the room capacity. Generate an X25519 key in your bot process, put only its public half in Developer → Permissions → Bot voice encryption key, and have a manager review the key fingerprint and room-media disclosure. Changes to the manifest require fresh voice-key review. Keep the private half in your process or an appropriately managed keystore; it is never sent to Meldiq.

`voice.connect` permits receiving the room’s audio, camera video, screen shares and other content shared in the call. Microphone-only is a publishing restriction; it does not restrict receiving to audio. Managers must review the full media-access disclosure before approval.

The main HTTP client needs no new dependency. The optional `javascript/voice.mjs` helper uses the separately installed `@hpke/core@1.9.0`. It offers `createVoiceKeys()` and `openVoiceKey(keys,response)`. Generated keys are non-extractable and live only in the bot process; restarting that process requires a new public key and manager review, unless you supply your own securely managed CryptoKeyPair. The helper never writes key material to files or logs.

`examples/voice-listener.mjs` is a listen-only example. From the extracted SDK root, install the optional dependencies with `npm install @hpke/core@1.9.0 @livekit/rtc-node@1.0.0` (the native media version used for qualification). Configure `MELDIQ_API_ORIGIN`, `MELDIQ_BOT_TOKEN` and `MELDIQ_VOICE_CHANNEL`, then run it on infrastructure you control. It prints only public configuration, waits for the public key and `voice.connect` to be reviewed, requests waiting admission, renews the lease and consumes encrypted audio without recording or publishing. A compatible member opens/joins the native room and supplies its encrypted key. The example waits up to 30 seconds for that key, then leaves if none arrives. Ctrl+C leaves the room. Its syntax is checked; automated integration tests separately exercise the SDK and transport paths.

To opt in, call `joinVoice(channelId,{requestId,waitForMember:true})`, or Python `join_voice(channel_id,request_id,wait_for_member=True)`. Keep the same request ID for an idempotent retry. An empty room or a room without a confirmed authorized human returns `state: "waiting_for_member"`, `callId: null` and `media: null`; it creates no call, media token or recording. Once a member connects, the lease can reserve native capacity and wait for the existing HPKE key handoff (`waiting_for_key`). Waiting-mode grants remain null until the packet arrives. Poll `voiceKey(leaseId)` and, when `key` is present, use `response.media ?? lease.media` with `openVoiceKey`. The returned `callId` supplies the real room context. `ready` describes a supplied key, not proof that the bot has connected. Existing clients that omit the flag retain their default existing-room behavior.

Waiting intents use the same one-lease-per-bot, global limit, authority checks, one-minute expiry and heartbeat rules. They do not join a person automatically or create a server-held key. Only a current authorized human media device can submit a key packet. Capacity reservations are serialized; a full room or unavailable SFU can be retried while the intent remains valid. An unbound intent has no media cleanup record; a bound reservation is recorded before a token can be issued. Revocation/expiry/shutdown cannot revive it.

Use a media SDK supporting LiveKit frame encryption. Native Meldiq's shared key input is the **UTF-8 text of `keyText`**, which is base64 of the32-byte room key, rather than the decoded32bytes. Configure encryption before connecting and never fall back to unencrypted media. The grant initially allows receiving only. After connecting, call `voiceConnected(leaseId)` to verify actual SFU presence and apply current microphone permission; publish only when its `canSpeak` is true. Video, screen and data publishing are excluded from this voice capability.

Renew with `renewVoice(leaseId)` roughly every15seconds while connected; leases expire after60seconds without renewal. Keep the stable request ID for a retry of the same join. Use `leaveVoice(leaseId)` to close admission and remove the participant. The Python HTTP methods are `join_voice`, `voice_key`, `voice_connected`, `renew_voice` and `leave_voice`; Python has no first-party media/HPKE helper in this preview.

The room key is relayed only as bounded HPKE ciphertext, bound to the call, channel, bot, lease and reviewed manifest revision. Ciphertext stays in API memory for the lease and is excluded from message history and journals. Rotation, uninstall, expiry, native restrictions and changed approval withdraw API admission and initiate SFU removal. Failed SFU removal is retained for retry. Self-hosted SFUs can accept a saved media token until their own expiry/revocation rules reject it; Meldiq’s signed-webhook admission checks remove stale connections. API denial alone does not prove media disconnection. A private durable ledger contains only bot/lease/call/room removal metadata, with no credentials, ciphertext or media keys, so restart and account/call deletion cannot lose cleanup work. A bot/operator can process media it is approved to receive; treat that media as private user data.

## Community file sharing preview

Request `files.upload` and/or `files.read` and have the community manager approve them. Old message/history approvals do not grant either new scope. Uploading also needs the bot's current native posting/attachment authority. Publishing a file reference needs `messages.post` and `files.upload`. These scopes do not change plan limits, storage quotas or existing retention. Personal bot chats do not accept files in this preview.

The API stores native encrypted bytes and validates completed objects before publishing references. Current v2 reference keys are visible to the Meldiq relay under the existing protocol; this is not server-resistant E2EE. The optional dependency-free Node helper uses the native whole-object AES-256-GCM format:

```js
import { encryptAttachmentBytes, decryptAttachmentBytes } from "./javascript/attachments.mjs";

// sourceBytes is data your operator process is authorized to share.
const encrypted = encryptAttachmentBytes(sourceBytes, { name: "report.bin", mime: "application/octet-stream" });
const stored = await bot.uploadAttachment(channelId, encrypted.bytes);
const reference = { ...encrypted.reference, id: stored.id };
await bot.send(channelId, "Report", { messageId: stableMessageId, attachments: [reference] });
const chunks = [];
for await (const chunk of bot.downloadAttachment(stored.id)) chunks.push(chunk);
const original = decryptAttachmentBytes(Buffer.concat(chunks), reference);
```

The convenience crypto helper buffers at most 64 MiB. For larger files use native streaming/chunk encryption and direct upload sessions; this helper limit does not reduce the API's existing plan allowance. A streamed download yields ciphertext chunks without buffering the whole file. Its optional `{range:"bytes=0-65535",signal}` follows native ranged-download semantics. Breaking the JavaScript iterator cancels its response. Verify the complete native checksum and authentication tag before using decrypted output; discard interrupted downloads. Chunked references need the native chunk-aware decoder, rather than the whole-object helper above.

JavaScript offers `startUpload(channelId,ciphertextSize,sha256)`, `uploadUrl(uploadId)`, `signUploadParts(uploadId,parts)`, `uploadedParts(uploadId)`, `completeUpload(uploadId,parts?)` and `cancelUpload(uploadId)`. A single session returns `upload`; a multipart session returns its part size/count and the signing method supplies each part's `upload`. PUT ciphertext using only each returned signed URL's method/headers. Do not add the bot Authorization header to storage requests. Verify the returned status/checksum, complete the native session, then publish the reference. No automatic mutation retry runs; use the same native session or message ID for an explicit retry. Presigned URLs have their native short lifetime; API renewal, completion and publication still require current authority.

Python has corresponding `upload_attachment`, `start_upload`, `upload_url`, `sign_upload_parts`, `uploaded_parts`, `complete_upload`, `cancel_upload` and `download_attachment` methods. Supply already encrypted bytes; the standard-library client does not provide Python AES-GCM. `download_attachment(id,byte_range=None,chunk_size=65536)` yields ciphertext. Close its generator when stopping early. Request timeouts, origin/namespace validation, redirect refusal and sanitized errors apply to both clients. A revoked in-flight download closes before completing the file.

Control-plane and local storage stand-in tests are distinct from real Frankfurt transfer performance and physical-client acceptance. This preview adds no hosted execution, plaintext server encryption, antivirus/scanning claim or quota/pricing change. Format/transport references: [Node authenticated encryption](https://nodejs.org/docs/latest-v22.x/api/crypto.html#ciphergetauthtag), [Node stream iteration](https://nodejs.org/docs/latest-v22.x/api/webstreams.html#async-iteration), [Python URL requests](https://docs.python.org/3.10/library/urllib.request.html).
