# Android / web call regression

These tests use the real Android repositories and call manager, the current server, and the web app's real
`LiveKitSession` (including its encryption worker). All accounts and messages are on a throwaway local server.
The emulator tests never sign into production.

Requirements: a booted Android emulator, the current API checkout with `server-messages`, the neighbouring
`meldiq_web` checkout with dependencies and Playwright Chromium, and `livekit-server`.

Start local media (test credentials only):

```sh
LIVEKIT_PORT=7898 LIVEKIT_TCP_PORT=7899 LIVEKIT_UDP_PORT=7900 LIVEKIT_DEV=0 \
LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=test-secret-that-is-at-least-32-characters-long \
bash ../meldiq_web/scripts/livekit-dev.sh
```

Start the fixture from the repository root. Point `MELDIQ_INTEROP_SERVER_DIR` at the current API checkout if the
root `server/` is older than API 0.57. For this workspace the matching API is in
`.claude/worktrees/community-parity/server`:

```sh
MELDIQ_INTEROP_SERVER_DIR="$PWD/.claude/worktrees/community-parity/server" \
  .claude/worktrees/community-parity/server/node_modules/.bin/tsx tools/call-interop/fixture.mts
```

It prints its randomly allocated API port. Forward that port plus the fixture and media ports to the emulator:

```sh
adb reverse tcp:8098 tcp:PRINTED_API_PORT
adb reverse tcp:8097 tcp:8097
adb reverse tcp:7898 tcp:7898
```

Build/install the debug app and its Android-test APK, then run:

```sh
adb shell am instrument -w \
  -e class com.meldiq.android.CallControlInteropTest \
  -e interopApi http://127.0.0.1:8098 \
  -e interopFixture http://127.0.0.1:8097 \
  -e interopMedia true \
  com.meldiq.android.androidtest/androidx.test.runner.AndroidJUnitRunner
```

Checks:

- Web voice-call and meeting keys enter Android through v2 queue events.
- Android sends call keys and answers web key requests with its background outbox disabled.
- Actual Android and web microphone/camera frames reach verified encryption on both sides, for a call and a
  meeting room. Closing the caller's UI coroutine during meeting setup must not cancel the call.

The media test is skipped unless `interopMedia=true`; all fixture tests are skipped in ordinary CI runs without
`interopApi` and `interopFixture`. Physical phone and restricted-network coverage remain separate checks.

For ordinary messaging, use the same fixture and emulator ports, and set
`-e class com.meldiq.android.MessageInteropTest` instead. These four tests check community and personal-inbox sends,
web-format replies, edits, reactions, server read markers, and retrying messages previously rejected with
`426 update_required`. Retries must clear the visible error and keep one server message with the original id.
Messaging tests do not need the local media server or `interopMedia`.
