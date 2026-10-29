-- 2026-10-30 (community parity batch C, posting tools; docs/COMMUNITY_PARITY_API.md › Posting tools). New tables only,
-- in the workspace domain (new MongoDB collections when it lives there), so older images ignore them and production's
-- readWrite-only user never needs collMod. Each goes with its community, and each channel's rows with the channel.
--
-- channel_webhooks:  a channel's webhooks (10 at most). Only the SHA-256 of the secret token is kept. user_id is the
--                    webhook's own sender account (users.kind 'agent', never a member anywhere): messages it posted
--                    keep a name after the webhook is deleted.
-- reaction_roles:    on one message, an emoji that gives a role to whoever reacts with it (20 per message). Deleting
--                    the role, the channel or the community removes the pair; deleting the message is handled by the
--                    server (messages aren't rows).
-- community_tickets: whether members may open tickets, how many each may have open, the next ticket number and the
--                    community's "Tickets" sender account (panels and logs).
-- ticket_panels:     where a panel is posted, the category its tickets open in, and where they're logged.
-- tickets:           one private channel per ticket, who opened it and why, and who closed it.

CREATE TABLE channel_webhooks (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  channel_id        TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL,
  name              TEXT NOT NULL,
  avatar_rev        INTEGER,
  token_hash        TEXT NOT NULL UNIQUE,
  token_rotated_at  INTEGER NOT NULL,
  created_by        TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  last_used_at      INTEGER
);
CREATE INDEX idx_channel_webhooks_channel ON channel_webhooks (channel_id);
CREATE INDEX idx_channel_webhooks_org ON channel_webhooks (org_id);

CREATE TABLE reaction_roles (
  message_id  TEXT NOT NULL,
  emoji       TEXT NOT NULL,
  org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  channel_id  TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  role_id     TEXT NOT NULL REFERENCES org_roles (id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  set_by      TEXT NOT NULL,
  set_at      INTEGER NOT NULL,
  PRIMARY KEY (message_id, emoji)
);
CREATE INDEX idx_reaction_roles_org ON reaction_roles (org_id);
CREATE INDEX idx_reaction_roles_role ON reaction_roles (role_id);

CREATE TABLE community_tickets (
  org_id       TEXT PRIMARY KEY REFERENCES orgs (id) ON DELETE CASCADE,
  enabled      INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  max_open     INTEGER NOT NULL CHECK (max_open BETWEEN 1 AND 10),
  next_number  INTEGER NOT NULL DEFAULT 1,
  poster_id    TEXT,
  updated_by   TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE ticket_panels (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  position           INTEGER NOT NULL,
  post_channel_id    TEXT REFERENCES conversations (id) ON DELETE SET NULL,
  category_id        TEXT REFERENCES channel_categories (id) ON DELETE SET NULL,
  log_channel_id     TEXT REFERENCES conversations (id) ON DELETE SET NULL,
  posted_message_id  TEXT,
  created_by         TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX idx_ticket_panels_org ON ticket_panels (org_id);

CREATE TABLE tickets (
  channel_id  TEXT PRIMARY KEY REFERENCES conversations (id) ON DELETE CASCADE,
  org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  panel_id    TEXT,
  number      INTEGER NOT NULL,
  opener_id   TEXT NOT NULL,
  about       TEXT NOT NULL,
  opened_at   INTEGER NOT NULL,
  closed_at   INTEGER,
  closed_by   TEXT
);
CREATE INDEX idx_tickets_org ON tickets (org_id, closed_at);
CREATE INDEX idx_tickets_opener ON tickets (org_id, opener_id);
