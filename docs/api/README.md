# Meldiq API contract

The canonical contract every client (Android, web, iOS) builds against. Architecture 1.0, step C2
([plan §4](../architecture/ARCHITECTURE_1_0_PLAN.md)).

| File | What |
|---|---|
| [`openapi.json`](openapi.json) | OpenAPI 3.1 for every client-facing HTTP route, with the error-code catalog as `x-error-codes` |
| [`COVERAGE.md`](COVERAGE.md) | Which routes and frames the test suite has verified against their schemas |
| [`realtime.schema.json`](realtime.schema.json) | JSON Schema of every WebSocket frame on `/v1/ws` (`ServerEvent`, `ClientEvent`) |
| [`../../shared/contracts/fixtures/`](../../shared/contracts/fixtures) | Golden examples: real answers (`http/`), error answers (`http/errors/`) and frames (`realtime/`) captured from the server's test suite |

**Source of truth:** the zod schemas in `server/src/shared/contracts/` (HTTP routes in `http/`, frames in
`realtime.ts`) and the error catalog in `server/src/shared/errors.ts`. The routes validate their input with these
schemas, and every server test checks each answer and frame it sees against them. Never edit the generated files by
hand:

```bash
cd server && npm run contracts
```

Fixtures are refreshed by deleting the files to refresh and running the suite with `MELDIQ_WRITE_FIXTURES=1`.
Credentials in them are replaced by `<redacted>` or a schema-compatible dummy; ids and times are from test runs.

**Rules for clients:**
- Ignore fields and frame names you don't know; fields are only ever added within an API version.
- Errors are always `{ "error": { "code", "message", "details"? } }`; branch on `code`, show `message`.
- Unknown queue item kinds or payloads get a placeholder, never a silent drop.
- Decode every fixture in your unit tests with your own models, so a contract change shows up as a failing test.
  Android: `android/app/src/test/java/com/meldiq/android/contract/ContractFixturesTest.kt` decodes the 154 answers the
  app uses, every frame and every error, with `GriipJson` and with a stricter decoder (unknown enum values or nulls);
  the fixtures live outside the Gradle module, so run it with `--rerun` after they change (CI always runs it).

**Coverage:** see the generated [route and frame coverage](COVERAGE.md). Not documented here, on purpose: the server-to-server
federation protocol (`/fed/v1/*`, the core node, [`docs/FEDERATION_PROTOCOL.md`](../FEDERATION_PROTOCOL.md)), the
LiveKit webhook (`POST /v1/livekit/webhook`) and the WebSocket upgrade itself (`GET /v1/ws`, whose frames are in
`realtime.schema.json`). Frames not yet seen by a test: `prefs.updated`, `meeting.updated`, `meeting.soon`.

The [bot SDK documentation](../../server/sdk/README.md#outbound-community-event-webhooks) describes the opt-in signed outbound event webhook, endpoint verification and retries.

Validation messages: the input errors of documented routes now come from zod 4, so the wording of `details[].message`
for built-in checks changed (custom messages didn't). Clients branch on `code` and show `message`, which are unchanged.
Known exception: a path that matches no route answers Fastify's own 404 body (`{ message, error, statusCode }`), which
the Android app relies on to detect an older server; it will move to the envelope in a compatible way.
