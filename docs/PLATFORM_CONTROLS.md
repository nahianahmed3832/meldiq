# Platform controls (API 0.59.0)

Switches an operator flips from the console's **Platform Controls** page that change what the server does for
everyone, from the very next request. Unlike the settings in `docs/PLATFORM_SETTINGS.md`, these are enforced by the
server itself, so they work with every app version already installed.

Who: super and operations admins (`controls.edit`), with a fresh passkey check and a written reason. Everyone with
`settings.view` can see them. Every change is audited as `controls.update` with its before and after values. Undo a
change by setting the old value back.

Storage: `platform_settings`, keys `control.<key>`, read on each use (one indexed row). An unset or invalid stored
value means the default. Code: `server/src/app/platformControls.ts` (reading and enforcement),
`server/src/modules/platformAdmin/controlsAdmin.ts` (the console's view and changes).

| Control | Default | Effect |
|---|---|---|
| `maintenance` | off | On: every app request answers `503 maintenance` with the operator's message (or a default) and `Retry-After: 300`. Still answered: `/healthz`, `/v1/server-info` (which reports `maintenance`), `/admin/v1/*`, `/v1/billing/webhooks/*` and `/v1/livekit/webhook`. Open sockets stay open until their next request. |
| `signups` | `environment` | `environment` follows `REGISTRATION_MODE`; `open`, `invite` (an invitation code) or `closed` (`403 registration_closed`; an operator's load-test invite still works on the legacy path). `/v1/server-info` reports the mode in force as `signups`; `registration` shows `closed` as `invite` for apps that predate it. |
| `email_domains` | none | New sign-ups with an address at a listed domain or any of its subdomains get `403 email_domain_blocked`. Up to 2,000 domains, stored lower-case and de-duplicated. Existing accounts aren't affected. |
| `features` | all on | Kill switches. `calls: false` refuses starting and joining calls; `uploads: false` refuses new attachments and direct uploads; `orgCreation: false` refuses creating organizations. Each answers `503 feature_disabled`. What already exists keeps working. |

API: `GET /admin/v1/controls` (every control with its value, who changed it and when, plus the environment's and the
effective sign-up mode) and `PUT /admin/v1/controls/:key` with `{ value, reason }`.

Tests: `server/test/platform_controls.test.ts`.
