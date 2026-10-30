-- 2026-10-30 (community parity batch D part 2, the remaining official bots; docs/COMMUNITY_PARITY_API.md › Official
-- bots). New tables only, in the workspace domain (new MongoDB collections when it lives there), so older images ignore
-- them and production's readWrite-only user never needs collMod. Each goes with its community. The Tickets bot keeps no
-- table of its own: its settings are batch C's tickets config, and its Bots+ extras live in official_bots.settings.
--
-- bot_giveaways:      prize draws started with !giveaway: where the card is, the prize, how many win, who hosts, the
--                     role entrants must hold (Bots+), when it ends, how many have entered so far (the lobby shows it),
--                     and once it ended, when and who won (JSON ids, rerolled winners appended). The scheduler ends due
--                     ones from ends_at, so a restart loses nothing.
-- bot_alert_watches:  YouTube channels the Alerts bot follows for a community: what was pasted, YouTube's channel id,
--                     name and uploads playlist, the channel new uploads are posted in, the role pinged (optional), the
--                     community's own line, the newest video ids already handled (JSON, deduplication) and when it was
--                     last checked. Only uploads published after created_at are posted.
-- bot_wordy_games:    one Wordy game per member per UTC day ("YYYY-MM-DD"): the guesses (JSON), solved or not, when it
--                     ended. Kept for a week (the recap reads yesterday's).
-- bot_wordy_stats:    each member's Wordy record in a community: games, wins, the current and best streak, the last
--                     day finished and won, and wins by number of tries (JSON array of 6).
-- bot_wordy_recaps:   the days whose recap was posted (claimed before posting, so it goes once).

CREATE TABLE bot_giveaways (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  channel_id        TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  message_id        TEXT,
  prize             TEXT NOT NULL,
  winners           INTEGER NOT NULL,
  host_id           TEXT NOT NULL,
  required_role_id  TEXT,
  entrants          INTEGER NOT NULL DEFAULT 0,
  ends_at           INTEGER NOT NULL,
  ended_at          INTEGER,
  winner_ids        TEXT NOT NULL DEFAULT '[]',
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_bot_giveaways_org ON bot_giveaways (org_id);
CREATE INDEX idx_bot_giveaways_due ON bot_giveaways (ended_at, ends_at);
CREATE INDEX idx_bot_giveaways_message ON bot_giveaways (message_id);

CREATE TABLE bot_alert_watches (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  source         TEXT NOT NULL,
  yt_channel_id  TEXT NOT NULL,
  creator        TEXT NOT NULL,
  uploads_id     TEXT NOT NULL,
  channel_id     TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  role_id        TEXT,
  message        TEXT,
  seen           TEXT NOT NULL DEFAULT '[]',
  checked_at     INTEGER,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_bot_alert_watches_org ON bot_alert_watches (org_id);
CREATE UNIQUE INDEX idx_bot_alert_watches_unique ON bot_alert_watches (org_id, yt_channel_id, channel_id);

CREATE TABLE bot_wordy_games (
  org_id       TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  day          TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  guesses      TEXT NOT NULL DEFAULT '[]',
  solved       INTEGER NOT NULL DEFAULT 0 CHECK (solved IN (0, 1)),
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  PRIMARY KEY (org_id, day, user_id)
);
CREATE INDEX idx_bot_wordy_games_user ON bot_wordy_games (user_id);
CREATE INDEX idx_bot_wordy_games_day ON bot_wordy_games (day);

CREATE TABLE bot_wordy_stats (
  org_id        TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,
  played        INTEGER NOT NULL,
  won           INTEGER NOT NULL,
  streak        INTEGER NOT NULL,
  best_streak   INTEGER NOT NULL,
  last_day      TEXT NOT NULL,
  last_won_day  TEXT,
  distribution  TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX idx_bot_wordy_stats_user ON bot_wordy_stats (user_id);
CREATE INDEX idx_bot_wordy_stats_won ON bot_wordy_stats (org_id, won);

CREATE TABLE bot_wordy_recaps (
  org_id     TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  day        TEXT NOT NULL,
  posted_at  INTEGER NOT NULL,
  PRIMARY KEY (org_id, day)
);
