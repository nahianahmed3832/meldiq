# Account safety (API 0.46.0)

Features `two-step`, `email-change`, `account-standing`, `bug-reports`, `profile-links`. **Migration 060** adds five
tables and two nullable `users` columns; nothing existing changes. Like passkeys, the new tables live in SQLite in
either accounts mode (no foreign keys to `accounts`), and account deletion removes them explicitly.

## Two-step sign-in (TOTP)

RFC 6238: HMAC-SHA-1, 6 digits, 30-second steps, one step of drift either way. A code works once (the last used step is
stored); ten single-use backup codes are shown once when it's turned on. The secret is sealed with
`PLATFORM_SECRETS_KEY` (AES-256-GCM, bound to the account) and is never stored in the clear; without the key,
`GET /v2/account/totp` says `available: false` and set-up answers `secrets_unavailable`.

| Route | |
|---|---|
| `GET /v2/account/totp` | `{ available, enabled, enabledAt, backupCodesLeft }` |
| `POST /v2/account/totp/setup` `{ password }` | `{ secret (base32), uri (otpauth://) }`; off until the first code |
| `POST /v2/account/totp/enable` `{ code }` | `{ backupCodes }` (within 15 minutes of set-up) |
| `POST /v2/account/totp/disable` `{ password, code }` | a code from the app or a backup code |

`POST /v2/auth/login` takes `totpCode` (app or backup code). With two-step on, a correct password without it answers
`401 totp_required`; a wrong code `401 totp_invalid`; five wrong codes pause that account's second step for 15 minutes
(`429 totp_locked`). Passkey sign-in doesn't ask (a passkey is already two factors). Turning it on or off emails the
account.

**Android:** the Android app doesn't send `totpCode` yet, so an account with two-step on can't sign in on Android with
its password until the app supports it (devices already signed in stay signed in; passkeys still work). The web app says
so before it's turned on.

## Changing the email

`POST /v2/account/email` `{ password, newEmail }` → 202; a 6-digit code goes to the new address (30 minutes, 5 tries,
5 requests an hour). If the new address already has an account, that address is told so instead and the asker gets the
same answer. `POST /v2/account/email/confirm` `{ code }` makes the change (verified at once) and tells the old address.

## Account standing

Warnings from staff, each with a reason and a number of days. `GET /v2/account/standing` →
`{ level, warnings: [{ id, reason, createdAt, expiresAt }] }`. The server enforces the level (`403 account_limited`):

| Active warnings | Level | Refused |
|---|---|---|
| 0 | `good` | nothing |
| 1 | `limited` | creating communities, creating invitations |
| 2 | `very_limited` | also starting new DMs or groups, joining communities |
| 3+ | `suspended` | also sending messages (controls and receipts still flow) |

Operator CLI: `admin.js warn <username> <days> <reason…>`, `warnings <username>`, `unwarn <warningId>`.

## Bug reports

`POST /v1/bug-reports` `{ summary (4–120), details (10–4000), page?, client? }` (10 a day), `GET /v1/bug-reports` (your
own, with staff's status and note). Nothing from messages is attached. Staff: `admin.js bug-reports [status]`,
`bug-report <id> [open|confirmed|fixed|not_a_bug|duplicate] [note…]`. A confirmed or fixed report gives its reporter
the `bug-hunter` badge (`badges` in profile views).

## About me and links

`PATCH /v1/users/me` takes `aboutMe` (up to 300 characters, null clears) and `links` (up to 5 `{ label, url }`, `https://`
only, null clears). Profiles show them under the bio's privacy setting.
