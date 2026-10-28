# Meldiq (formerly Orbit and Griip Message)

**Meldiq by GriipBuddy** · *Private by design. Connected by everyone.*

A native Android community messaging app (communities with channels, categories, forums and voice channels, plus
private messages and calls), as an internal beta. Rebuilt community-first on 2026-10-21
([community rebuild](docs/COMMUNITY_REBUILD_2026-10-21.md)): the workplace modules and optional connectors are gone. Renamed from Griip Message
to Orbit on 2026-10-16 and from Orbit to Meldiq on 2026-10-19 ([rebrand notes](docs/MELDIQ_REBRAND_2026-10-19.md)).
Protocols (`griip-envelope-v1`, `griip-fed/1`) and their cryptographic labels, the S3 bucket and key prefix, the AWS
stacks and the Docker project keep their names until a planned migration
([infrastructure plan](docs/MELDIQ_INFRASTRUCTURE_PLAN_2026-10-19.md)).
- **Messaging:** end-to-end encrypted direct messages, groups and community channels, threads and forum posts.
- **Communities:** public or invite-only, discoverable, with categories, roles, per-role channel permissions and bans.
- **Calls:** voice and video calls and Android screen sharing over a self-hosted LiveKit SFU.
- **Storage:** history is kept on the device, and the relay keeps encrypted envelopes for at most 7 days.

> Internal beta. Servers can federate (v1, not yet deployed). Read [`docs/SECURITY.md`](docs/SECURITY.md) and [`docs/SECURITY_AND_PRIVACY.md`](docs/SECURITY_AND_PRIVACY.md) before using it for sensitive information.

| | |
|---|---|
| Android application ID | `com.meldiq.android` (Meldiq, owner's choice 2026-10-19, matching meldiq.app). Earlier: `com.griipbuddy.meldiq` (first Meldiq test builds, never published), `com.griipbuddy.Orbit` (Orbit, its Google Play listing), `com.griipbuddy.orbit` (2026-10-16 only) and `com.griipbuddy.message` (Griip Message). Each is a separate app: app data never moves between them; accounts come back by signing in, linking the device or the recovery key |
| APK | Test builds in `artifacts/` (debug-signed, not committed), e.g. `artifacts/meldiq-test-2026-10-19.apk` |
| Relay / API | `https://msg.griipbuddy.cloud` today; the Meldiq API hostname follows once its domain is bought and approved ([environments](docs/ENVIRONMENTS.md)) |
| Calls (LiveKit) | `wss://rtc.griipbuddy.cloud`, media on 7881/tcp and 7882/udp |
| Compose project | `griip-internal-messaging` in `/opt/griip-internal-messaging` on 72.60.107.88 (name kept on purpose, see `deploy/compose.yaml`) |

## Install & try

1. Install the APK. You can use `adb install artifacts/meldiq-test-2026-10-19.apk`, or copy it to the phone and open it.
2. Tap **Get started**, pick a display name and a username. Your keys are created on the phone.
3. Join a community with an invite code or from **Discover**, or create one. Owners and admins create invites from **Community → Manage → Invitations**.
4. Save your recovery key from **Profile → Security & recovery**.
5. For background delivery, keep **Settings → Stay connected in background** on, and allow the app in your phone's battery manager.

## Build

Android needs JDK 17+; Android Studio's bundled JBR works.

```bash
cd android && ./gradlew :app:assembleDebug
```

The APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. Debug builds default to the development
server (`http://localhost:8080`, reached from a phone through `adb reverse tcp:8080 tcp:8080`); release builds to
production. Choose another address per environment with `meldiq.apiBaseUrl.<environment>` in `android/local.properties`
or `-P` ([environments](docs/ENVIRONMENTS.md)).

The server needs Node 22+. Install, test, then build:

```bash
cd server && npm install
```

```bash
cd server && npm test
```

```bash
cd server && npm run build
```

Run it locally:

```bash
cd server && PORT=8080 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=<32+ chars> LIVEKIT_PUBLIC_URL=ws://<lan-ip>:7880 npm start
```

For local calls, run `livekit-server --dev` and use `devkey`/`secret` with a matching secret.

## Deploy

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). Always use project-scoped commands:

```bash
docker compose -p griip-internal-messaging -f /opt/griip-internal-messaging/compose.yaml ps
```

## Test against the app with Griip Bot

`tools/griip-bot` is a headless second participant. It echoes messages, verifies attachments, and answers or places E2EE calls,
and it logs the media it receives.

```bash
cd tools/griip-bot && npm install
```

```bash
cd tools/griip-bot && npm run bot -- chat <yourUsername> 1800
```

```bash
cd tools/griip-bot && npm run bot -- call <yourUsername> video 120
```

## Documentation
- [Design system](docs/DESIGN_SYSTEM.md): how the supplied reference was translated
- [Architecture](docs/ARCHITECTURE.md) and [Decisions](docs/DECISIONS.md)
- [Security](docs/SECURITY.md) and [Retention](docs/RETENTION.md)
- [Deployment](docs/DEPLOYMENT.md) (GriipBuddy production) and [Self-hosting](docs/SELF_HOSTING.md) (your own server)
- [Connecting the app to a server](docs/ANDROID_SERVER_SETUP.md): server check, several servers on one phone
- [Calling and call encryption](docs/CALLING_AND_E2EE.md), [Voice messages](docs/VOICE_MESSAGES.md), [Troubleshooting](docs/TROUBLESHOOTING.md)
- Federation: [protocol](docs/FEDERATION_PROTOCOL.md), [global identities and discovery](docs/GLOBAL_IDENTITIES_AND_DISCOVERY.md),
  [server lifecycle](docs/SERVER_LIFECYCLE.md), [security and privacy](docs/SECURITY_AND_PRIVACY.md), [audit and plan](docs/FEDERATION_GAP_ANALYSIS.md)
- [Decision records](docs/decisions/README.md)
- [Testing](docs/TESTING.md): what passed, failed or wasn't verified, with evidence
- [Continuous integration](docs/CI.md): the checks that run on every push to `internal-beta` and every pull request
- [Release builds and signing](docs/RELEASE_BUILDS.md) and [operational security remediation](docs/SECURITY_REMEDIATION.md)
- [Abuse controls](docs/ABUSE_CONTROLS.md): registration, sign-in, upload, storage and realtime limits, and how to recover from false positives
- Meldiq rebrand (2026-10-19): [what changed and what kept its name](docs/MELDIQ_REBRAND_2026-10-19.md),
  [environments and endpoints](docs/ENVIRONMENTS.md), [infrastructure plan for the new domain](docs/MELDIQ_INFRASTRUCTURE_PLAN_2026-10-19.md)
- Orbit 2.0 (email-and-password accounts, workspaces, legacy migration, 1 GB files): [audit](docs/ORBIT_2_MOBILE_AUDIT_2026-10-18.md),
  [architecture and API contracts](docs/ORBIT_2_ARCHITECTURE_2026-10-18.md), [implementation report](docs/ORBIT_2_IMPLEMENTATION_REPORT_2026-10-18.md)
- [Activity status](docs/ACTIVITY_STATUS.md): opt-in "Playing …" from the Android app (API 0.56.0), and its Google Play permission declaration
- [Known issues](docs/KNOWN_ISSUES.md) and [Progress](docs/PROGRESS.md)
