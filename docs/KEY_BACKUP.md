# Key backup under the password (2026-10-21)

The owner's rule: setting up a new device should need **email, password and an emailed code**. The recovery key is
only for when the email can't be verified or the password was reset.

## What a new device does

1. Signs in with email and password, as before.
2. If the account has a usable backup, device setup offers **Get a code by email** first (Android: *Unlock your
   messages*; web: the *Code by email* tab).
3. The server emails a 6-digit code to the account's address. The person types it in.
4. The server returns the sealed keys. The device opens them with the password, checks that they are the account's
   identity, and adds itself exactly as with a recovery key.

Other options stay below the email option: approve from another phone, the recovery key, start fresh. With no usable
backup, the screen says why (for example after a password reset) and offers those.

## Format (version 1)

Shared by Android `crypto/KeyBackupCrypto.kt` and web `src/crypto/keyBackup.ts`. A test vector made with Node is checked
by both clients' tests (`KeyBackupCryptoTest`, `test/keyBackup.test.ts`).

| Part | Value |
|---|---|
| Key | PBKDF2-HMAC-SHA256 of the password's UTF-8 bytes, random 16-byte salt, 600,000 rounds, 32 bytes |
| Sealed | AES-256-GCM, random 12-byte nonce, over the 32-byte identity seed (48 bytes with the tag) |
| Associated data | `meldiq-key-backup-v1\n<account id>\n<identity key>` |

Stored per account: version, rounds, salt, nonce, ciphertext and identity key (migration 031, `account_key_backups`;
MongoDB when `accounts` is in `MONGODB_DOMAINS`).

## When a backup counts

Only while the account's password and identity are the ones it was made for. The server compares
`password_changed_at` and `users.identity_key`, so no hook can be forgotten:

| Event | Backup |
|---|---|
| Sign-up, then the first device makes the identity | made by that device |
| A device is set up (email code, recovery key, another phone, start fresh) with the password in memory | made if none is usable |
| A phone signs in again with its own keys | made if none is usable |
| Password changed on Android | sealed again under the new password in the same request |
| Password changed on the web | stale: the browser keeps no seed. Other sessions are signed out, and the phone backs up again when it signs in with the new password |
| Password reset, or account recovery with a recovery code | stale. The recovery key or another device is needed, and that device then backs up again |
| Start fresh (new identity) | stale; the new identity is backed up |
| Settings › Key backup › Turn off | deleted |
| Account deletion | deleted, with any unlock in progress |

## API

| Route | Who | What |
|---|---|---|
| `GET /v2/account/key-backup` | any session | `{exists, updatedAt}` for the current password and identity |
| `PUT /v2/account/key-backup` | a session bound to a device, with `{password, backup}` | checks the password and that `backup.identityKey` is the current identity |
| `DELETE /v2/account/key-backup` | a session bound to a device | turns it off |
| `POST /v2/account/key-backup/unlock/start` | any session | emails a code for this session; answers `delivery` (`email`, or for a console-made account `fixed_code`/`none` with no email, docs/ADMIN_ACCOUNTS.md); 404 `no_key_backup` when there's nothing to unlock |
| `POST /v2/account/key-backup/unlock` | the same session, `{code}` (`{}` for `delivery: none`) | the sealed keys; single use |
| `POST /v2/account/password` | as before, plus optional `keyBackup` | the keys sealed under the new password replace the backup |

Feature flag `key-backup`. Audit events: `account.key_backup_saved`, `account.key_backup_removed`,
`account.key_unlock_started`, `account.key_unlocked` (no codes or key material).

## Limits and abuse

- Unlock codes: 6 digits, 15 minutes, 5 wrong tries, at most 5 emails per account an hour.
- A code works only for the session that asked for it, and only once.
- The routes that hash a password or send email share the per-network limit of the other sign-in routes.

## Security: what this changes

This is weaker than the recovery key, by the owner's choice (2026-10-21). Stated plainly:

- **The server can't open a backup on its own.** It never has the derived key.
- **But it sees the password at every sign-in**, as with any password sign-in. A server operator who records
  passwords, or an attacker who controls the server, could open a backup. Before this change, the server alone could
  never get the keys.
- **A stolen database** gives the attacker the ciphertexts. They'd have to guess passwords offline against PBKDF2 with
  600,000 rounds; a weak password falls quickly. Password rules (docs: `PASSWORD_PROBLEMS`) still apply.
- **Someone with the password and the inbox** can set up a new device and read messages. Before this change they'd
  also have needed the recovery key or another device. Every unlock sends an email, and the device appears in the
  device list.
- **Without the inbox**, the password alone isn't enough: the code is required. The exception is an account an
  operator made in the admin console with no code or a fixed tester code (API 0.63.0, docs/ADMIN_ACCOUNTS.md): the
  operator chose that, for testers whose addresses may not receive mail.

People who want the old guarantee can turn the backup off (Android Settings › Key backup, web Settings › Account).
Then a new device needs the recovery key or another device again.

## Tests

- Server `test/key_backup.test.ts` (11 tests, SQLite and MongoDB): saving rules, a session without a device, the
  unlock (wrong code, another session's code, single use, attempt limit), no backup, reset, change with and without
  re-sealing, a re-sealed backup of other keys refused before anything changes, start fresh, turning off, deletion.
- Android `KeyBackupCryptoTest` (7 tests, shared vector) and `KeyBackupFlowTest` (6 tests): first phone backs up, new
  phone unlocks, password asked when forgotten, reset then recovery key backs up again, password change re-seals,
  Settings turns it on.
- Web `test/keyBackup.test.ts` (4 tests, shared vector) and `test/live-key-backup.test.ts` (3 tests against the real
  server).

Deployed as API 0.11.0 and Meldiq Web 7d48f85 on 2026-10-21 (docs/DEPLOYMENT.md). Not done: a phone test on a real
device, and a new Android build (the owner builds and signs it).
