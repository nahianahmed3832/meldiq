# Accounts made in the admin console (API 0.62.0; new devices 0.63.0)

Operators create Meldiq accounts from the console's **Accounts** page (`#/accounts`) — for testers before the store
release, reviewers, or people the team signs up by hand — and choose how each one proves its email address:

| Verification | What the person does | Email sent |
|---|---|---|
| `verified` | Signs in with the email and password straight away. The operator vouches for the address. | none |
| `static_code` | Signs in; the app asks for the verification code as after any sign-up; the operator's fixed six-digit code works (with the password), until its optional end. The normal emailed code works too. | none, also not when the app asks to send it again (a tester's address may not receive mail) |
| `email` | The normal flow: the code is emailed (now, and again whenever the app asks). | the verification code |

After the address is verified, signing in is email and password (plus the person's own two-step code if they turn it
on), exactly as for everyone else: there is no code at every sign-in for any account.

**A new device** (API 0.63.0, reported 2026-10-29: testers were stuck on the second browser or phone). Opening the
encrypted messages on a device that has no keys yet normally needs a code emailed to the account (docs/KEY_BACKUP.md).
For accounts made here, `POST /v2/account/key-backup/unlock/start` answers `delivery` and sends no email unless it is
`email`:

| Verification | `delivery` | Step 2 (`POST /v2/account/key-backup/unlock`) |
|---|---|---|
| `verified` | `none` | no code: `{}` gives back the sealed keys, which still open only with the password |
| `static_code` (until its end) | `fixed_code` | the fixed code |
| `static_code` after its end, `email`, every other account | `email` | the emailed code, as before |

Step 2 is still bound to the session that started it, single use and limited to 5 wrong tries; starts share the 5-an-hour limit of emailed codes, so a fixed code cannot be guessed by starting again. The audit entry
`account.key_unlock_started` carries `none` or `fixed_code` in its detail. The web app skips the code screen for
`none` and asks for the tester code for `fixed_code`; an older app shows the emailed-code screen, where the fixed code
works and, for `none`, any six digits do.

Rules:

- Who: super and operations admins (`accounts.create`), with a fresh passkey check and a written reason. Everyone with
  `users.view` sees the list; email addresses only with `users.view_email`.
- Public sign-up controls (`docs/PLATFORM_CONTROLS.md`: closed sign-ups, blocked domains, network limits) don't apply:
  the operator decides.
- A password is chosen by the operator (the normal strength rules apply) or generated (24 random characters) and shown
  once in the console; it is never stored in the clear or written to the audit log.
- A fixed code is stored like an emailed one: a SHA-256 hash bound to the account, never the code itself.
- A public sign-up with the address of an operator-made account never replaces its password (with a known tester code
  it would otherwise hand the account over); with `email` verification the owner just gets the code again.
- Changing the verification later is audited; choosing `verified` marks the address proven at once.
- The console can also give access in the same step, through the existing routes: a console role
  (`POST /admin/v1/admins`, which answers a one-time enrolment code) and a Meldiq Mojo free period
  (`POST /admin/v1/billing/grants`).

API: `GET /admin/v1/accounts` (newest first, keyset pages), `POST /admin/v1/accounts`,
`PUT /admin/v1/accounts/:accountId/verification`. Audit actions `account.create` and `account.verification`.
Storage: `operator_accounts` (migration 068, platform domain); the account itself is a normal account
(`admitted_via: "operator"`). Code: `server/src/modules/accounts/operatorAccounts.ts`,
`server/src/modules/platformAdmin/accountsAdmin.ts`. Tests: `server/test/admin_accounts.test.ts`.
