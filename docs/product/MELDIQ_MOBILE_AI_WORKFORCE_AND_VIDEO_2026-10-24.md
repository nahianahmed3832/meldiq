# Mobile: AI Workforce and the video module (2026-10-24)

The owner's "AI Workforce, video module & full feature integration" brief, worked on Android against the shared backend
(`internal-beta` f8c86e9, API 0.33.0 in production) and Meldiq Web (`meldiq-web` main d7e0b33).

## 1. What the audit found

### Android (the only mobile client; iOS is a plan only)

Kotlin and Jetpack Compose, one `AppContainer` for dependencies, Room (SQLCipher) for local data, the shared REST API
plus a WebSocket (`RealtimeClient`), FCM wake-ups, end-to-end encrypted messages (`EnvelopeV1`), and LiveKit Android
2.29 for calls with frame encryption. Calls: `call/CallManager.kt` (room, tracks, screen share through LiveKit's
MediaProjection service with Meldiq's notification and Stop action, reconnection), `ui/screens/calls/*` (stage, tiles,
share sheet, picture-in-picture). Voice messages: one `VoicePlayer` for the whole app (`voice/VoiceAndroid.kt`).

### The video module update of 2026-10-23/24

- Server `b48436f` (API 0.33.0): one device per person in a call, newest wins. The older device gets
  `call ended` with `endReason: "joined_elsewhere"` and is removed from the room; it stays signed in.
- Web `b131926`: screen-share Standard 720p30 / High 1080p60, several shares at once with a tray and a per-viewer
  choice, one voice message at a time, "You joined this call on another device".

What Android already had and kept: leaving the call on the server's `ended` message without ending it for others (so
newest-wins worked, with a generic text); one voice message at a time app-wide, paused on audio-focus loss (another app,
a ringing call) and stopped when the conversation closes or the person signs out; Text (1080p15) and Game (720p30) share
modes; adaptive stream, so screens that aren't drawn aren't sent to this phone.

### AI Workforce backend: not there

There is no agent catalog, workspace installation, agent identity, channel assignment, job, approval or deliverable API
on the server, and no agent screens on the web. `server/src/modules/ai` is the Platform Admin AI gateway only:
provider connections, models, prices, quotas, a kill switch (off by default), and one allowed feature, the console's
connection test. Its rule (`docs/AI_OPERATIONS.md`): no product feature uses AI until one is approved, and the gateway
never receives conversation content, because messages are end-to-end encrypted.

## 2. Checklist and status

| Item | Status |
|---|---|
| Newest device wins: say "You joined this call on another device" | **Done** (`CallOverlay`, `vid_joined_elsewhere`) |
| Screen share High 1080p at 60 fps | **Done**, offered only where a hardware VP8 encoder reports 1080p60 (`ShareEncoders`, `CallMediaPolicy.canShareHigh`); 8 Mbit/s, keeps the frame rate under congestion |
| Say when High sends clearly less (under 45 fps or under 1000 lines, measured) | **Done**, on the sharing banner |
| Several shares at once: tray with Watch/Watching, per-phone choice, a new share never takes over | **Done** (`CallTiles.watchedShare`, `ShareTray`, `CallManager.watchShare`) |
| At most 3 screens shared at once | **Done**, checked before Android's consent dialog and again when the share starts |
| Changing the share mode during a share | Not done: needs the capture and encoder changed on a live track; stop and share again for now |
| One voice message at a time, stopped on leaving | Already in place (no change) |
| Agent catalog, installed agents, Agent Manager, channel agents, jobs, approvals, deliverables | **Blocked**: no backend (section 1). Not faked on the phone |

## 3. Why the AI part needs a decision first

Building it means a server project first (catalog, per-workspace installs and identities, channel assignments, a job
runner with states and cancellation, approvals bound to job/action/artifact version, deliverables through the file
system, quotas through the existing gateway), and two decisions only the owner can make:

1. **Encryption.** Channel messages are end-to-end encrypted, so a server-side agent can't read them. The options are an
   agent that only sees what a person explicitly sends it (a task form with chosen files, consent shown each time), or an
   agent as a channel member with its own device key held by the server, which means the server can read that
   channel. The second changes Meldiq's privacy promise.
2. **Turning AI on for products.** The gateway allows no product feature today, by design.

## 4. Tests

Unit (JVM, no device): 708 Android tests, 0 failures, including `ShareHighAndSelectionTest` (High mode, the encoder
rule, "sending less", share selection, the three-share cap). Lint: 0 errors. Not tried on a phone or the emulator yet:
High mode needs a real phone's encoder, and several shares need three devices in one call.

## 5. Android AI Workforce (2026-10-24, later the same day)

The owner then said AI features are enabled and about to be released. The server and web work exists (another
session, uncommitted in the main folder at the time: `server/src/modules/workforce`, `docs/AI_WORKFORCE.md`,
Meldiq Web `src/ui/agents`). Android now matches Meldiq Web against those routes; nothing on the phone runs agents.

| Piece | Where |
|---|---|
| Models for every answer (`views.ts`) and request (`aiWorkforce.ts`) | `data/ai/AiModels.kt` |
| API client for `/v1/orgs/:orgId/ai/…` and `/v1/conversations/:id/ai/…`; streamed uploads; resumable downloads | `data/ai/AiWorkforceApi.kt`, `ApiClient.uploadStream` |
| `ai.posts` / `ai.job` frames → screens refetch (ids only; the fetch decides access) | `RealtimeEvents.kt`, `MessageSignals.aiEvents`, `AiWorkforceSignals` |
| @Agent / /command parsing, which recent messages may be shared (150 messages, 30,000 characters, 2,000 each), file checks, who steers and who approves | `data/ai/AgentRules.kt` |
| A skill's options from its JSON Schema (choices, switches, numbers, text, lists) | `data/ai/SkillForm.kt` |
| Community › AI agents: Agents (catalog, install), Manager, Requests (mine / everyone's for managers), Approvals, Files | `ui/screens/ai/AgentsScreen.kt` |
| Ask sheet: agent, brief, options, files, share recent channel messages (off until picked), the notice, one idempotency key per sheet | `ui/screens/ai/AskAgentSheet.kt` |
| Request view: real state, the job's own progress while it works, steps, files and earlier versions, approve / reject this version, request changes, answer, cancel, retry | `ui/screens/ai/JobSheet.kt` |
| Agent settings: name, avatar and colour, role, description, language, style, instructions, review mode, limits, tools, channels and how it's asked, on/off, update, remove | `ui/screens/ai/AgentSettingsScreen.kt` |
| Channels: a line above the composer when agents work there, their posts (labelled AI, not end-to-end encrypted), Ask; "@Agent …" and "/agent …" open the request instead of being sent encrypted | `ui/screens/ai/ChannelAgents.kt`, `ConversationScreen` |
| Entry points: Community settings › More › AI agents, and a shortcut on the community panel, only when server-info lists `ai-workforce` | `CommunitySettingsScreen`, `CommunityHomeScreen` |
| Strings in English, Chinese and Bengali (`aw_` keys) | `android/i18n/strings_ai.py` |

Privacy: as on the web, a person's brief, chosen files and (only when they pick a number) the channel's recent
messages as this phone decrypted them are the only content that reaches an agent; every sending and showing screen
says it isn't end-to-end encrypted. Agent files open only through the app's FileProvider; a file that could install or
run software isn't opened.

Not done on Android: notifications for AI jobs (the server sends no push for them; while the app is open, screens update
from the realtime frames), threads (requests go to the channel itself), changing role-limited invokers (web neither).

Dependencies before release:
- The server's AI routes have no route contracts, so `docs/api/openapi.json` doesn't list them and Android's
  `ApiRoutesTest` fails on `/v1/orgs/{}/ai` and `/v1/conversations/{}/ai/…` until they're added (`npm run contracts`).
- Android's `RealtimeCodecTest` expects `ai.posts` and `ai.job` in `docs/api/realtime.schema.json`, which the AI
  server change adds. Land the server change with or before this one.

Tests: `AgentRulesTest`, `SkillFormTest`, `AiModelsTest` (answers shaped as `views.ts` writes them). With the AI
server's generated files: 719 of 720 Android tests pass (the route contract above). Not tried against a running AI
server or on a phone: production has no AI Workforce yet, and no provider is configured anywhere.

## 6. Matching Meldiq Web's AI agents to API 0.41.0 (2026-10-25)

Meldiq Web (`ai-workforce-web`, up to `0f42277`) and the server (API 0.36.0–0.41.0) moved on after §5. Android now
has the same features:

| Web feature | API | Android |
|---|---|---|
| Configure an agent step by step: identity, models, skills, channels, permissions, autonomy, triggers, limits, test and activate (readiness, a real test, activity) | 0.36.0–0.37.0 | `AgentSettingsScreen.kt`, `AgentAutomation.kt` |
| Remove an agent from the list | 0.35.0 | `AgentsScreen.kt` |
| Agents like bots in channels: posts among the messages, `@Agent`/`/agent` sent straight to them (notice once), suggestions while typing; agents in the member list | 0.35.0 | `ChannelAgents.kt`, `AgentTimeline`, `ConversationScreen`, `DmDetails` |
| Tasks for people: lists, report, actions the server allows, hand-in with files, who the Agent Manager may give work to | 0.39.0 | `TasksTab.kt` |
| Agents reading conversations, opt-in: reader devices only with `x-meldiq-ai-reader: 1`; a message goes to a reader only when its sender chose to share (text, edits, deletes; no choice is keep); the notice and the choice in place of the composer; reading settings; direct conversations | 0.40.0 | `Directory.kt`, `MessageRepository.readersFor`, `ChannelAgents.kt`, `AgentAutomation.ReadingCard` |
| Overview first: what needs you, in progress, failed, finished, estimated cost, the last system check | 0.41.0 | `WorkTabs.WorkTab` |
| Health: Run Full System Check, grouped results, earlier runs, export | 0.41.0 | `WorkTabs.SystemCheckTab` |
| Monthly AI budget per agent, with this month's cost | 0.41.0 | `LimitsStep` |

Tests: 736 Android tests pass, including `KeyDirectoryReadersTest` (a reader is never an ordinary recipient; shared only
on "share"; a changed agent key is dropped without pausing the conversation), `AgentTimelineTest`, `AiOperationsTest`,
`AiWorkRulesTest`, and every AI golden fixture the server records (48 routes) decoded normally and strictly. Lint: 0
errors. Not tried on a phone: AI Workforce is switched off in production, and reading channels is off there too.
