# Meldiq leaderboards

Settings → Leaderboards has six independent, server-authoritative boards. The API is `GET /v2/leaderboards?metric=level|messages|voice|embers|gifts|invites` and requires a signed-in device. No score can be supplied by the client.

- Level: actual purchased account levels above level 1.
- Embers: lifetime earned totals; spending never reduces this score.
- Messages: live messages from the last seven days in community text channels the viewer can access. DMs, imports and inaccessible channels are excluded.
- Voice: complete minutes in accessible community voice rooms over the last seven days, using retained participation records. Overlapping devices/calls are merged per person. Existing participant rows retain the latest join after a reconnect, so this is recorded participation, not a lifetime attendance ledger.
- Gifts: verified paid/redeemed Mojo gifts sent, excluding refunds and disputes. Recipients, notes, prices and provider information are never returned.
- Invites: rewarded invitations after a friend stays seven days, subject to the existing monthly reward limit. Pending joins are excluded.

The first 100 people are returned along with the viewer's own entry even when outside that list. Equal values use competition ranks (1, 1, 3); user IDs break display-order ties. Bots, synthetic identities, deleted/disabled accounts, foreign identities and blocked users are excluded. Username discovery and public photo privacy are respected. Permission checks happen on every request.

The web uses Meldiq's own vector symbols, medals, theme colors and existing avatar decorations. Loading, empty and retry states are explicit. Arrow keys, Home and End operate the category tabs. Sidebar search includes ranking terms. Membership marks now share an aligned name container, and compact marks appear in DM rows and headers. A Mojo Check remains a membership perk, never a claim of identity verification.

No database migration, balance change, payment change or new collection is needed. Both the SQLite/memory development stores and MongoDB production stores implement the new read methods.
