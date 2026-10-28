# Server-stored messages on Android (API 0.57.0, 2026-10-29)

The owner's decision of 2026-10-28: Meldiq stops encrypting messages end to end. The server stores every message and
every change and serves them to each device (server: `docs/SERVER_MESSAGES.md`, branch `release-0.57.0`; in production as API 0.57.1 since 2026-10-29). This is the
Android side, built against API 0.57.0 alongside Meldiq Web. Everything here runs only on a server that announces the
`server-messages` feature (`/v1/server-info`); the version number isn't checked.

## What changed

| | Before | Now |
|---|---|---|
| Sending | payload encrypted per device (`EnvelopeCrypto`), `POST /v1/messages` | the same payload JSON, `POST /v2/messages` (`MessageRepository.sendOne`, `sendSelfControl`); idempotent on the message id |
| Receiving | queue items of kind `envelope`, opened and verified | queue items of kind `message` (`{v: 2, event}`) applied as they are (`MessageReceiver.ingest`), acknowledged like envelopes; older `envelope` items still open during the transition |
| History | kept on the phone (Room), optionally uploaded encrypted (`HistorySync`) | loaded from the server in pages as a conversation opens and scrolls back (`ServerHistory.loadLatest`, `loadOlder`, `loadAround`) |
| Chat list | the phone's own counts | `GET /v2/messages/summary` on every connection: newest message, unread and mentions as the server counts them |
| Search | the phone's database only | `GET /v2/messages/search`, loaded, then the same local query |
| On the phone | every message, kept | a working copy, emptied at every start (`ServerHistory.clearWorkingCopy`); unsent and failed messages stay until sent |
| Files | encrypted per file, key in the message | unchanged (as Meldiq Web): the file's key travels in the stored payload |

Loaded history is applied with a `history` flag: shown, but never counted unread, notified, rung (old call invitations)
or marked read on other devices. The server enforces who may edit, delete or close a poll (`403 not_yours`) and the plan's
characters per message (`413 message_too_long`, shown on the failed message).

## The one-time move of the phone's history

On the first connection after updating (`ServerHistory.importLegacy`, as the web's `legacyImport.ts`):

1. What the account's old encrypted history on the server holds is read once (`HistorySync.catchUp(fromStart = true)`).
2. Every kept text message is uploaded with its reactions, poll votes, poll closing and pin as changes
   (`StoredEvents.importItems`), oldest first, 150 per `POST /v2/messages/import`. The server keeps the first copy of each
   id and skips the rest, so several devices uploading the same chat is harmless.
3. Only after every batch was accepted are the phone's copies deleted (messages and downloaded files) and the import
   marked done. A failure leaves everything for the next start.

Deleted messages, call lines and undecryptable placeholders upload nothing; the server keeps calls itself.

## What people are told

- Once, at the top of Messages: messages now live on Meldiq's servers, travel over encrypted connections, and members of
  a conversation (and Meldiq's staff when a report or the law requires it) can read them.
- Every "end-to-end encrypted" claim about messages, files, polls, search and sign-in was replaced with what is true now
  (`android/i18n/*.py` and the screens). Calls show "Encrypted call" (media still uses a per-call key, which now travels
  through the stored chat, so Meldiq's servers can see it).
- Settings › Storage no longer offers "Keep my messages on the server" or a restore; Settings › Account no longer offers
  key backup. Device sign-in keys stay: they are the sign-in credential.

## Not done here

- Production has `MESSAGES_ACCEPT_ENCRYPTED` off: installed apps older than this build get `426 update_required` when they
  send, so this build should reach testers and Google Play soon. The new app never sends envelopes.
- The encrypted-history and key-backup code stays in the app for sign-in and the one-time import; removing it is a
  follow-up once every device has moved.
- Thread lists, pinned and file views read what the phone has loaded; the server has no per-thread or per-file query yet.
