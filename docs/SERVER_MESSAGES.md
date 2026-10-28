# Server-stored messages (API 0.57.0, 2026-10-29)

The owner's decision (2026-10-28): Meldiq stops encrypting messages end to end. The server stores every message and
every change to one, and serves them to each device, so no browser or phone keeps chats of its own, needs a backup, or
loses anything with a device. Apps keep only what signs them in.

What this means for people, said plainly in the apps: messages and files are kept on Meldiq's servers and travel over
encrypted connections (TLS); members of a conversation, and Meldiq's staff when a report or the law requires it, can
read them. Older wording ("end-to-end encrypted", "the server only relays ciphertext") is gone from the web app.

Code: `server/src/modules/messaging/serverMessagesRoutes.ts`, `store/messageStore.ts` (SQLite), `store/mongoStore.ts`
(MongoDB, the `history` domain), `sendRules.ts` (the send checks both message routes share). Migration
`066_message_store.sql`. Tests: `server/test/server_messages.test.ts`, `profile_mutuals.test.ts`.

## Routes

| Route | |
|---|---|
| `POST /v2/messages` | `{ conversationId, messageId, cls, sentAt, payload, mentionAll?, audience? }`. The payload is the JSON the apps used to encrypt (`type`, `text`, `replyTo`, `attachments`, `target`, `emoji`, ...). Idempotent on `messageId`. |
| `GET /v2/conversations/:id/messages` | `?before=<serverTs>&limit=` (newest first) or `?around=<messageId>`: `{ messages, changes, more }`. `changes` are the controls that point at those messages, oldest first: apps apply them as live ones. |
| `GET /v2/messages/summary` | For each conversation you're in: newest message, your read position (your own `read` controls), unread messages and mentions since (up to 99). Apps build their lists from it after a page load. |
| `GET /v2/messages/search` | `?q=&conversationId?=`: text messages containing the words, in conversations you're in. |
| `POST /v2/messages/import` | A device's history from before 0.57.0, uploaded once when the app updates: up to 200 items, only into conversations the uploader is still in, never in the future; the first copy of each id wins, and each records `importedBy`. |

Delivery: every active device of the current members (the sender's other devices too) gets a delivery-queue item of
kind `message` whose payload is `{ v: 2, event }` (the stored event). Offline devices are woken as before; messages
wake, changes don't. Delivered receipts work as before.

## Rules the server now enforces itself

The server used to relay ciphertext and leave these to each recipient's app. Now it checks:

- Edits, deletions and closing a poll: only by the message's sender (`403 not_yours`), only in the message's own
  conversation.
- Meldiq Mojo's characters per message and per edit, counted as people count them (grapheme clusters; `413
  message_too_long`). Older apps' encrypted envelopes keep the size bound.
- Everything `POST /v1/messages` checked: standing, membership, posting rights, timeouts, voice channels, slowmode,
  message requests, blocks, @everyone policy and rate.

## Older apps

`POST /v1/messages` (encrypted envelopes) answers `426 update_required` unless `MESSAGES_ACCEPT_ENCRYPTED=true`.
Apps from before 0.57.0 can't read stored messages and new apps don't read envelopes, so a mixed conversation can't
work: turn it on only for a short transition while the new Android app rolls out. Keep it off once the Android update
is out.

## Migration of existing history

Messages sent before 0.57.0 exist only on devices (and in each account's own encrypted history, which only that
account's devices can read). The new web app, on its first start, uploads what its old browser database holds and what
it can read of the account's encrypted history, then empties the old database and cached media. The Android app does
the same from its database (see its own report). Messages nobody's device still holds can't be recovered by the server.

## Capacity

Messages are small: production's whole database was 25.65 MiB on 2026-10-28, on Atlas M0 (512 MB). `mongo-estimate`
and Atlas's own storage view show the growth; move to a paid tier well before 70% (`MONGODB_STORAGE_LIMIT_MB`).

## Also in 0.57.0

- Meldiq Spark levels at 2, 5 and 8 active Sparks in total (owner, 2026-10-28; was 1, 2 and 3): `billing/perks.ts`.
- Profiles carry `memberSince` and `mutualCommunities` (the profile card's "Member since" and mutual communities).
- Built on API 0.56.0 (`release-0.56.0`: Google Play Billing and activity status), and carries `mongo-finish` 1977da1:
  every remaining domain can run from MongoDB, but which ones do is still `MONGODB_DOMAINS` (unchanged by this release;
  see docs/MONGODB_CUTOVER_RUNBOOK.md before adding any).
