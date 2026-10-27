# Proposal: letting an AI agent read a channel (opt-in, per channel)

Status: **proposal, nothing built** (2026-10-24). It needs the owner's decision first, because it changes Meldiq's end-to-end
encryption promise for every channel that switches it on.
Builds on `AI_WORKFORCE.md` (§2: today agents never hold keys) and `SECURITY.md` (§3 envelope, §4 known gaps, §7 call media).

## 1. The question

Today an agent only sees what a person hands it on purpose: a brief and chosen files, with a "not end-to-end encrypted"
notice. It can't read the channel. That rules out the most-asked-for agent work:
- "summarise #support since Monday";
- "answer questions from what was decided here";
- an agent that watches a channel and triages requests.

Every one of those needs the agent to read messages nobody handed it. Messages are end-to-end encrypted to member
devices, and the server can't read them. So the only way is for the agent to **be a member**: hold a device key in
the channel, receive each message wrapped to that key, and decrypt it on the server.

This document works out how to offer that as an explicit, visible, per-channel choice. It also sets out what it costs
in privacy.

## 2. The trade-off in one paragraph

When a channel switches this on, its new messages stop being private from the people who run the server. The device
key that decrypts them sits on the server, so an operator with root access, or anyone who compromises the server, can
read them from then on. The decrypted text also goes to the AI provider the platform uses.

Channels that don't switch it on keep exactly the protection they have today. So do DMs and groups, where it can never
be switched on. Nothing below makes a reading channel as private as a normal one. The design only makes sure four
things hold:
- the change is the channel's own choice;
- every member sees it before they post;
- the exposure stays limited to that channel, from that moment forward;
- switching it off really ends it.

## 3. Goals and non-goals

Goals:
- A channel manager can let **one installed agent** read **one channel**, from now on.
- Every member is told in the channel, and acknowledges it, before their next message is shared with the agent.
- Each member can keep their own messages out of what the agent reads (§6.3).
- Switching it off revokes the key and erases what the agent stored.
- One channel's exposure never extends to another channel, to DMs, to groups or to calls.

Non-goals:
- **Past messages.** People wrote them under the promise that no agent could read them, so they are never shared (§7).
- **DMs and private groups.** Never, at any setting.
- **Calls.** The agent never gets call keys or media (§6.5).
- **Fixing server-asserted membership.** This is an existing gap (`SECURITY.md` §4). This design doesn't fix it, and it
  adds no new way to exploit it (§9).
- **Attachments in the first version.** Text only. Files stay "hand them to the agent" (§11).

## 4. Options considered

| | How | Privacy | What it enables | Effort |
|---|---|---|---|---|
| **A. Status quo** | A person hands the agent a brief and files | Strongest: no key ever leaves member devices | Requests about files and briefs; nothing about the conversation | none |
| **B. Share recent messages per request** | Ask dialog gets "Include the last N messages here". The asker's browser decrypts them and sends them with the request, the way the earlier web Catch up did (`orbit_web/src/ui/ai/AiDialogs.tsx`, at most 150 messages / 30,000 chars) | No key leaves members' devices. But the asker shares **other members'** messages without their say, once per request | "Summarise / answer from what's above", on demand | small (≈2–3 days) |
| **C. An agent reader in the channel (this proposal)** | A server-held member account with one device, opt-in per channel, forward-only, per-member opt-out | That channel's new messages become readable by the server operator and the AI provider. Bounded, visible, revocable | Everything B does, plus standing context, watching and triage, answers without someone re-sharing | large (≈3–4 weeks across server, web, Android) |
| **D. On-device models** | Run a model in each member's app | Strongest, like A | Small summaries only; nothing that needs tools, files or long context. Not workable in the browser today | very large, poor quality |

**Recommendation:** ship **B** first (**built 2026-10-24**, `AI_WORKFORCE.md` §2; Android still to do). It covers the common "catch me up" case without moving any key, and it reuses a
consent pattern people have already seen. Build **C** only if the owner accepts §2, and only as the opt-in below.
B stays available in channels that turn C on.

## 5. Who can switch it on

All of these must hold, and each is checked live, every time the reader receives a message:

1. **Platform:** `ai.workforce.channel_reading` is on (a new platform setting, **off by default**). Turning it off stops
   every reader at once and is audited.
2. **Agent template:** the catalog entry is marked `canReadChannels` by an operator in the AI Control Center. Agents
   that only need files never get it.
3. **Community entitlement:** the community's AI entitlement allows channel reading (a new field, off by default).
4. **Channel type:** the conversation is a `CHANNEL`. The server refuses `DM` and `GROUP` with a new error,
   `ai_reading_not_allowed`.
5. **Who:** a member holding `ai.manage` who can also manage that channel (rename, permissions). They give a reason, and
   the switch is written to the community audit log.
6. **Not federated:** channels don't federate today (shadows can't join groups, `FEDERATION_PROTOCOL.md` §6.1). When
   channel federation is designed, a channel with a reader must stay local until a remote server can show the same
   notice.

Each channel has at most one reader at a time. A second agent replaces the first, and replacing counts as switching
off and on again, notice included.

## 6. Design

### 6.1 What the agent is

Each (agent install × channel) gets its own **reader account**:
- a `users` row with a new `kind = 'agent'` column, a reserved username (`agent.<install>.<channel>`), the agent's
  display name and avatar;
- one device, whose identity and device keys are generated on the server.

The account:
- joins the channel as a member;
- can't sign in, can't be searched and can't be added anywhere else;
- has no history sync and gets no push.

Why one account per channel and not one per agent: the server makes senders wrap every message to **all** of a member's
active devices in a conversation. An account holding several channels' keys would leak those keys to each other.
With one account per channel, a stolen key opens exactly one channel, and revoking a reader touches nothing else.

### 6.2 Key custody

- The private keys never sit in the database in plain form. Each reader's keys are sealed (AES-256-GCM) under a
  per-reader key, and that key is wrapped by `AI_READER_MASTER_KEY`:
  - an environment secret kept apart from the database and from backups;
  - loaded only by the workforce worker;
  - absent from the HTTP process, the console and the operator CLI.
- Switching off **crypto-shreds**: it deletes the per-reader key and the device is revoked (`devices.revoked_at`, the
  existing `devices.changed` event). What's left on disk or in backups can't be decrypted.
- Keys are never rotated in place. Members pin the reader's identity key on first contact (TOFU, `SECURITY.md` §3), and
  a changed key would pause sending in a large channel. A rotation is therefore a new reader account with a new notice.
- Honest limit: this keeps the keys away from a database leak and a stolen backup. It does **not** protect them from
  someone with root on the running server. Nothing can, as long as the server decrypts.

### 6.3 Member notice and consent

1. **When it's switched on**, the reader's own device posts the first message in the channel, end-to-end encrypted like
   any other, and members' clients render it as a system notice:
   - "*Reel Maker (AI agent) can now read new messages in this channel. Turned on by Alice, reason: …*";
   - who can see the text: the server's operators and the AI provider (named);
   - how long it's kept.
2. **Before a member's next send**, their client pauses sending in that channel until they choose one of:
   - *Share my messages with Reel Maker*;
   - *Keep my messages from Reel Maker*;
   - *Leave the channel*.

   This reuses the existing "Paused: a security key changed" path, so a message typed before the notice is never
   shared without the person having seen it.
3. **A persistent banner** in the channel, an **AI** badge on the reader in the member list, and a lock icon in the
   channel header that changes from "End-to-end encrypted" to "End-to-end encrypted · readable by an AI agent".
4. **Each member's choice is theirs, and changeable at any time** from the banner. It's enforced on the sender's own
   device: "keep" means their client doesn't wrap the content key to the reader (§6.4). The server can't override it,
   because it never has that member's key.
5. **Reading other people's messages.** A member can't stop the agent from reading what *others* share. Their options
   are to keep their own messages out, or to leave. The notice says so.

### 6.4 The one server rule that changes

Today a send is refused (`409 device_mismatch`) unless its recipients equal **exactly** the active devices of current
members (`messagesRoutes.ts`). The new rule:
- **human members' devices:** all still required, exactly as now;
- **reader devices:** allowed but optional.

That one change lets each sender's client decide what the reader gets:

| Envelope | Wrapped to the reader? |
|---|---|
| A message from a member who chose *share* | yes |
| A message from a member who chose *keep*, or who hasn't chosen yet | no (sending is paused until they choose) |
| Edits, deletes and reactions for a message the reader received | yes, so it can update or erase its copy |
| `call_invite`, `call_key_request`, any other call control | **never** |
| Anything in a channel whose reader was switched off | no (the device is revoked) |

A modified client could still wrap something to the reader that its user didn't mean to share. That's no worse than
that user copying the text anywhere else.

### 6.5 Calls stay out

Call media keys travel inside an E2EE `call_invite` to the conversation's devices (`SECURITY.md` §7). If the reader got
one, the server would hold both the media key and the SFU's packets, and could decrypt the call. So:
- clients never wrap call controls to a reader (§6.4);
- the reader's account is refused by `POST /v1/calls/:id/join` and never issued a LiveKit token;
- a test asserts that no call key ever reaches a reader device.

### 6.6 What the reader keeps

The worker drains the reader's queue (the relay keeps items for 7 days, as for any device), verifies each envelope's
signature against pinned keys like a client does, and decrypts it. It then keeps:
- **A context window:** at most 30 days or 2,000 messages, whichever is smaller (the channel may choose less). Stored
  in a new `ai_channel_context` table, each row sealed under the per-reader key. Older rows are deleted on a schedule.
- **Message ids, senders and times,** so answers can cite "Alice, 14:02".
- **Nothing from members who chose *keep*.** The reader never had those messages.
- **Deletes for everyone and edits** are applied to the stored copy as they arrive. What the agent already *said* in
  the channel about a deleted message isn't unsaid. Agent posts are separate server-stored items (`AI_WORKFORCE.md`
  §2), and their authors can delete them.

Activation (`ai_agent_channels.activation`, existing: `mention`, `command` or `explicit`) still decides when the agent
**acts**. A standing "watch and triage" mode would be a new value, switched on separately. In every mode the reader
**reads** every shared message, because a mention is inside the encryption and can't be seen otherwise. The notice says
"reads", not "reads when asked".

### 6.7 What reaches the AI provider

- Only the context a job needs, built by the existing prompting rules: content is marked untrusted, and instructions
  found inside messages are treated as data, not commands.
- The routing for a reading channel can be restricted to providers the operator marks **no retention / no training**
  (a new model flag). If none is verified, reading jobs fail plainly and don't fall back to another provider.
- Usage rows record the channel and the message count, never the text.

### 6.8 Switching off

Who can switch it off:
- the channel's managers;
- anyone with `ai.manage`;
- the community owner;
- a platform operator (emergency control, with a reason).

Removing the agent install or the channel, or the platform turning reading off, does the same. In order:
1. The device is revoked: members' clients stop wrapping to it on their next send.
2. The per-reader key is deleted: the context store and any unread queue items become unreadable.
3. Context rows and queue items are deleted, and the reader account is disabled.
4. A notice is posted in the channel (by the switching member's client, end-to-end encrypted): "*Reel Maker can no
   longer read this channel. What it kept has been erased.*"
5. Jobs that are running are cancelled with a new final reason, `reading_disabled`, through the existing final-cancel
   path (`workforce/jobs.ts`, like `agent_disabled`).

## 7. Past messages: why not, and what we'd do if asked

New devices get no backfill today (`MESSAGE_HISTORY.md`), and readers shouldn't get one either. The technical route
would be a consenting admin's client re-encrypting what it has locally. That would hand over other people's words,
written under a promise that no agent could read them, on one person's say.

If the owner wants a history option anyway, the least bad form is B (§4): an explicit, one-off share by a person, of
messages they can see, with the same notice. Nothing standing.

## 8. Who can read what

| Who | Normal channel (today) | Channel with a reader, member chose *share* | Member chose *keep* |
|---|---|---|---|
| Channel members | everything | everything | everything |
| The agent (worker) | only what's handed to it | new messages, from switch-on, for ≤30 days | nothing of theirs |
| AI provider | only what's handed to it | what each job sends | nothing of theirs |
| Server operator / root on the server | metadata only (`SECURITY.md` §1) | new shared messages while the reader is on, plus the context window | metadata only |
| Database leak or stolen backup | metadata only | metadata, plus sealed rows (unreadable without the master key) | metadata only |
| Leak of the master key **and** the database | metadata only | the context window of every **active** reader | metadata only |
| After switch-off | n/a | nothing new; stored copies crypto-shredded | n/a |
| DMs, groups, other channels, calls | unchanged | unchanged | unchanged |

**Blast radius:**
- one reader key opens one channel, forward, until switch-off;
- the master key plus a database copy opens every active reader's context window (≤30 days each);
- nothing opens DMs, groups, calls or channels without a reader.

## 9. What this doesn't fix

- **Server-asserted membership** (`SECURITY.md` §4). A malicious server can already add a member with certified devices
  and read new messages. A reader is a *declared* version of that, with a notice and an opt-out. Clients flag accounts
  of `kind = 'agent'`, but that flag is server-asserted too. A server that lies about it is the existing gap, not a new
  one. Signed group state (MLS or a signed membership log, `DECENTRALISATION_READINESS.md` item 4) is what would make
  the notice verifiable.
- **No forward secrecy** (`SECURITY.md` §4). A stolen reader key opens everything wrapped to it that the attacker
  captured, for as long as it was active. Short context windows and switch-off limit the damage, but they don't stop it.
- **Derived output.** Summaries and answers the agent has posted can't be recalled when a source message is deleted.
- **What members choose to share.** The opt-out is per member and forward-only. Someone who chose *share* and then
  *keep* has already shared their earlier messages, which stay in the context window until it ages out or the reader
  is switched off.

## 10. Legal and policy notes (not legal advice; to check with counsel)

- **GDPR.** For EU members, the platform becomes a processor of message content for that community, and the AI provider
  becomes a sub-processor:
  - DPAs are needed with both;
  - the provider's region matters;
  - the per-member opt-out and the retention limit support data minimisation;
  - the notice text is a transparency notice and should name the provider and the retention.
- **Workplace monitoring.** In workplace communities this can amount to monitoring employees' communications. Several
  jurisdictions require notice, consultation (works councils) or a stated purpose. That's why there's a reason field,
  an audit entry, and an opt-out no manager can override.
- **The promise.** The app's "end-to-end encrypted" wording must change for these channels (§6.3), and the privacy policy
  needs a section on agent reading.

## 11. Changes, by component

**Server:**
- a migration: `users.kind`, `ai_channel_readers` (install, channel, account, sealed keys, state, timestamps), and
  `ai_channel_context`;
- the recipient rule (§6.4), the call refusal (§6.5) and the reader worker (queue drain, verify, decrypt, store, apply
  edits and deletes);
- switch on and off, routes and audit, the platform setting, the entitlement field, the template flag, the provider
  retention flag, and the new error codes;
- the console: a "Channel reading" line in the AI Control Center, and its emergency off.

**Web:**
- the notice and acknowledgement pause, the *share* / *keep* choice, the banner, the AI badge and the header label;
- the per-recipient wrap rule;
- the switch in Agent settings;
- the system notices.

**Android:**
- the same, in `EnvelopeCrypto` callers, the conversation screen and the member list.
- Android has no AI agents area yet (`AI_WORKFORCE_PROGRESS.md`), so this depends on that work.

**Docs:**
- `SECURITY.md` §1, §4 and §7;
- `AI_WORKFORCE.md` §2 and §8;
- the privacy policy and the in-app notice text.

**Test peer:** the reference client (`server/test/support/griipClient.ts`) gets the per-recipient rule, so server tests
cover it with real crypto.

## 12. Phases

| Phase | What | Rough effort |
|---|---|---|
| 0 | Owner decision on §2 and the open questions; counsel on §10 | — |
| 1 | Option B in the web Ask dialog (and Android when its AI area exists). **Web done 2026-10-24** | 2–3 days |
| 2 | Server: reader accounts, key custody, recipient rule, worker, switch on/off, audit, settings; reference client | 1.5 weeks |
| 3 | Web: notice, pause, choice, banner, labels, wrap rule, settings | 1 week |
| 4 | Android: the same | 1 week, after its AI area |
| 5 | Security review of the composition (new code that decrypts on the server), then a staged rollout: one internal channel, then opt-in communities | 3–5 days + soak |

Phases 2 and 3 can ship behind the platform setting, off. Nothing reaches a member until phase 5 turns it on for a
channel.

## 13. Tests

**Server:**
- A DM or group refusal.
- Each of the six conditions in §5 refuses on its own, and is rechecked live: turning the platform setting off stops a
  running reader.
- A send without the reader's wrap is accepted. A send missing a human device is still `409`. A wrap to a revoked
  reader is refused.
- Call join is refused for the reader. A `call_invite` wrapped to a reader is never stored for it.
- Edit and delete reach the stored copy. Retention trims it.
- Switch-off:
  - deletes the per-reader key, so sealed rows fail to open;
  - revokes the device and disables the account;
  - cancels running jobs.
- The reader account can't sign in, be searched or be added elsewhere.
- The console sees counts only, never context (extends the existing console privacy test).

**Reference client and web:**
- Before acknowledging, sending is paused. With *keep*, no wrap to the reader goes out (the ciphertext request is
  inspected). With *share*, there is one.
- Call controls never include the reader.

**End to end (web, Playwright):** switch on in Agent settings, then:
1. the notice appears;
2. a second member is paused, chooses *keep*, sends, and the agent's answer doesn't contain their message;
3. switch off;
4. the closing notice appears, and the lock label is back.

**Crypto interop:** the Android and reference client produce the same per-recipient choice from the same inputs (the
existing interop harness).

## 14. Open questions for the owner

1. Accept §2 at all, for opt-in channels? If not, ship B and stop.
2. Should a workplace community be able to make *share* **required** to post (members who decline can read but not
   post)? This proposal says no: an opt-out a manager can't override is what makes the notice consent rather than
   information. It's also safer under workplace-monitoring rules.
3. Context window: 30 days / 2,000 messages, or shorter?
4. Must reading channels use no-retention providers only (§6.7), or is that a per-community choice?
5. Attachments later: allowed under the same switch, or a second switch with its own notice?
6. Which name in the notice: the provider's name ("Anthropic", "OpenAI"), or "the AI provider Meldiq uses" with a link?
