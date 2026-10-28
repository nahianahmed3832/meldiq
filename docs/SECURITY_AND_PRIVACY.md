# Security and privacy of the federated network

Scope: what changes with federation (2026-10-16). Base security model (envelopes, keys, storage, calls): `SECURITY.md`.
End-to-end encryption hides **content**. It doesn't hide who talks to whom, when, or how much. This document says exactly what each
party can still see.

## 1. Threat boundaries

```
 ┌ Alice's device ┐   TLS   ┌ Server A ┐  signed TLS  ┌ Server B ┐   TLS   ┌ Bob's device ┐
 │ keys, plaintext│ ──────▶ │ metadata │ ───────────▶ │ metadata │ ──────▶ │ keys,        │
 │ (E2EE ends)    │         │ ciphertext│             │ ciphertext│         │ plaintext    │
 └────────────────┘         └────┬─────┘              └────┬─────┘         └──────────────┘
                                 │ domain / server-id       │
                                 ▼ queries, heartbeats      ▼
                          ┌ core nodes (registry only: servers, never users or messages) ┐
                          └──────────────────────────────────────────────────────────────┘
 Call media: devices ──SRTP + frame E2EE──▶ caller's LiveKit (SFU) ◀── callee's device (direct to the host's media server)
```

## 2. Attackers: what they can and can't do

| Attacker | Can learn / do | Can't |
|---|---|---|
| **Malicious home-server operator** (own users) | Everything `SECURITY.md` §1 lists: who its users talk to (incl. remote addresses), when, sizes, IPs of its users, online state; can delay or drop messages; can publish new keys for its own users (detected by contacts' pinning and safety numbers); can lie about group membership (groups aren't federated) | Read message, attachment, voice or call content; forge messages from another server's users; impersonate users of other servers; read other servers' queues |
| **Malicious peer server** | Its own users' metadata about conversations with your users: your users' addresses, ids, identity and device public keys (only for exact lookups or shared conversations), timing and sizes of what you send to its users | Read content; deliver as users of another server (`sender_not_from_peer`); act on calls for users that aren't its own (`not_your_user`); create conversations other than the DM id derived from the two people; overwrite your users' shadows or local ids (`id_conflict`); replay requests (nonces) |
| **Malicious core-node operator** (one node) | Which servers exist, their domains, endpoints, keys, reachability; which home servers query which domains or server ids, and when (not which user asked); can refuse to answer or answer wrongly | Mint a descriptor for a server id (self-certifying); roll a server back (seq + key chain); bind a domain without the endpoint's challenge proof; outvote a quorum; forge a revocation alone (threshold); see users, contacts or messages |
| **Colluding quorum of core nodes** | Could bind an *unbound or released* domain to a server they control | Change bindings already pinned by home servers without a visible "different server" warning; change any user's identity key without contacts' pinning flagging it |
| **Network observer** | That a device talks to its home server and when; that two servers talk (and sizes, timing); call media endpoints and volume | Content (TLS + E2EE); request contents between servers (TLS); in production, http is refused |
| **Compromised server database** | Metadata above, ciphertext queues and attachments (≤ 7 days), public keys, server's federation private key (then: impersonate that *server* to peers until revoked/rotated) | Decrypt any message or call (no content keys on servers); impersonate users (their device keys aren't on the server) |
| **Device compromise** | That device's history and keys (as before) | Other devices' keys; past messages on devices it never had |
| **Traffic correlation by cooperating observers** | Linking "A's server sent N bytes to B's server" with "Bob's device downloaded N bytes" | Not prevented: Griip doesn't offer anonymity (§5) |
| **Obsolete client** | Older apps can't resolve global addresses; they still decrypt federated messages they receive (same envelope) | Weaken others' encryption (no downgrade exists: one envelope format) |

## 3. Proof that infrastructure can't read content

Tested in `server/test/federation_e2e.test.ts` and on two local servers with the Android app (`TESTING.md` §8):

- Reference clients that encrypt and verify like the app decrypt each other's messages across two servers; a message counts only
  after the recipient's client verified the sender device's certificate against the **pinned** identity key, the envelope signature,
  the HPKE key unwrap and the AES-GCM tag.
- Both servers' complete SQLite files (database + WAL) and attachment stores were searched for the test plaintexts and the voice audio:
  **not found** (vitest and the local two-server run).
- The servers never hold content keys: the per-message key is wrapped to recipient devices (HPKE); the attachment key and the call media
  key travel only inside the encrypted envelope.
- A server substituting a remote user's identity key is caught by the recipient's pinned key (the client refuses to encrypt).

## 4. Metadata: what each party can still observe

| Data | Sender's server | Recipient's server | Core nodes | Network |
|---|---|---|---|---|
| Sender and recipient ids/addresses | yes | yes | no | no (TLS) |
| That servers A and B talk | yes | yes | indirectly (A resolved B) | yes |
| Message timing, count, sizes | yes | yes | no | sizes/timing of TLS traffic |
| Attachment sizes, upload time (type is inside the E2EE payload; the server sees `application/octet-stream`) | yes | yes | no | sizes |
| Delivery and read state | delivery receipts are server-made; read receipts are E2EE controls (timing visible) | same | no | no |
| IP addresses | its own users' | its own users' | servers' IPs | yes |
| Online state / typing | its own users only (not federated) | same | no | no |
| Game being played (opt-in, `ACTIVITY_STATUS.md`) | its own users only, while they share it (not federated) | same | no | no |
| Call participants, start/end, duration | if it hosts or mirrors the call | same | no | media endpoints |
| IP of the remote callee | the **host's LiveKit sees the remote callee's device IP** (direct media connection) | its own user's | no | yes |
| Group membership | not federated | — | — | — |

Minimisation in place: queues ≤ 7 days and deleted on acknowledgement; federation nonces 10 minutes, inbox dedupe keys 8 days; logs
never include bodies, tokens or keys (Fastify request bodies aren't logged; authorization headers are redacted); the audit log records
which peer looked up (not whom); presence and typing aren't sent across servers; exact-address lookup only.

## 5. Evaluated and not implemented

- **Sealed sender** (hiding the sender from the recipient's server): not compatible as-is. The recipient's server must verify that a
  server delivers only for its own users (anti-spoofing) and must apply blocks; hiding the sender would need delivery tokens or anonymous
  credentials and an abuse design. Not built; documented as a future option.
- **Anonymity / "anonymous mode":** not offered. Without mixing, padding and a relay network with a real threat model, such a label would
  mislead. Users needing network-location privacy should use a VPN or Tor to reach their own server (their server then sees the exit,
  not them). Cross-server calls still connect directly to the host's media server.
- **Privacy relays for federation traffic:** not implemented (§6.4 of the protocol): server-to-server delivery is direct.
- **Padding / batching for traffic analysis:** only natural batching of outbox items; no padding.

## 6. Core-node trust and separation

- Each node has its own key and database; resolvers are configured with each node's public key and a quorum. Operators should be
  independent organisations; the protocol doesn't assume any one of them is honest, only that fewer than a quorum collude.
- Tampering is detectable: every answer is signed by the node; descriptors are signed by servers; replicated records verify on their own;
  rollbacks are refused; disagreement without quorum fails closed.
- A node can **suppress** (not answer, answer stale): quorum and caching limit the impact (the newest valid descriptor from any node
  wins; stale ones can't roll a server back).
- Core nodes see no user data at all: no user names, no lookups by users, no messages.

## 7. Server secrets and the app

The Android app never receives server secrets: LiveKit API secrets stay on the host server (tokens are minted there); server identity
private keys stay in the server's data volume; session tokens of one server are never sent to another; a remote server sees only signed
requests from the user's home server, never the user's own credentials.
