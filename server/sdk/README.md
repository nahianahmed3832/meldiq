# Meldiq native bot clients — preview

These are first-party source clients for Meldiq's native bot API, not a vendor-compatible protocol or a published package. JavaScript uses Node.js22.4+ built-in fetch/WebSocket; Python3.10+ uses the standard library for HTTP and long polling. The API's generated contracts remain authoritative: `docs/api/openapi.json` and `docs/api/bot-gateway.schema.json`.

Check `/v1/server-info` for `bots`, `bot-permissions` and, on PostgreSQL, `bot-event-gateway`. The expanded API is a candidate until its release is approved. No bot code is hosted by Meldiq.

1. Make a bot in Settings → Developer and keep its token in your bot process's environment. The token is shown once; rotating it revokes the old credential and closes its gateway sessions.
2. Request the access your bot needs in Developer → the bot's Permissions. For event-driven text bots this normally includes Events and Read earlier messages.
3. A community manager adds the bot and approves its requested access in Community settings → Integrations → Permissions. New requests do not expand an existing approval automatically.
4. Give it only the native roles/channel access it needs. Approval does not grant native roles, bypass denials or confer owner/administrator powers. A scoped SDK request can still correctly receive403.

Existing text sends and slash commands retain their native baseline. Advanced administration, history, reactions and community event delivery need the corresponding approval. Rich messages and controls additionally require `messages.post` approval, labelled “Rich messages and controls” in the UI. Voice participation remains an unfinished slice of the broader platform. Avatar/banner uploads use the existing native MIME, size, processing and storage policies.

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
