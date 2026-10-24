-- 2026-10-24: human tasks for AI Workforce 2.0, phase 4 (docs/AI_WORKFORCE_2_PLAN.md). Additive only.
-- Work for people in a community: created by an admin or by the Agent Manager on an admin's request, assigned to a
-- member, done only when someone other than the assignee accepts what they submitted. Stored on the server (not end-to-
-- end encrypted), like agents' posts and files.
--   waiting      created by a plan, waiting for the agent steps it depends on; not shown as work yet
--   open         assigned, not accepted yet
--   accepted     the assignee took it on
--   in_progress  the assignee is working on it (also where returned work goes back to)
--   blocked      the assignee can't go on (blocked_reason says why)
--   submitted    the assignee handed in a note and/or files; waiting for review
--   done         accepted by a reviewer (never the assignee)
--   cancelled    withdrawn, or a step it depended on failed
CREATE TABLE ai_tasks (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL,
  title            TEXT NOT NULL,
  instructions     TEXT NOT NULL,
  deliverables     TEXT NOT NULL DEFAULT '',           -- what counts as done
  assignee_id      TEXT NOT NULL,
  created_by       TEXT NOT NULL,                       -- the person on whose authority it exists
  install_id       TEXT,                                -- the agent that created it (Agent Manager); NULL: a person
  job_id           TEXT,                                -- the request it belongs to
  conversation_id  TEXT,                                -- where it's announced and reminded
  priority         TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  state            TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('waiting', 'open', 'accepted', 'in_progress', 'blocked', 'submitted', 'done', 'cancelled')),
  depends_on       TEXT NOT NULL DEFAULT '[]',          -- job ids that must complete before it opens
  reference_files  TEXT NOT NULL DEFAULT '[]',          -- agents' deliverables the assignee may read for it
  due_at           INTEGER,
  blocked_reason   TEXT,
  submission_note  TEXT,
  return_reason    TEXT,
  returns          INTEGER NOT NULL DEFAULT 0,
  reminders        INTEGER NOT NULL DEFAULT 0,
  last_reminder_at INTEGER,
  escalated_at     INTEGER,
  cancel_reason    TEXT,
  rev              INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  opened_at        INTEGER,
  accepted_at      INTEGER,
  submitted_at     INTEGER,
  done_at          INTEGER,
  done_by          TEXT
);
CREATE INDEX idx_ai_tasks_org ON ai_tasks(org_id, state, due_at);
CREATE INDEX idx_ai_tasks_assignee ON ai_tasks(assignee_id, state);
CREATE INDEX idx_ai_tasks_job ON ai_tasks(job_id);

-- Every change of a task: who, when, what (reasons and notes are the people's own words, kept as history).
CREATE TABLE ai_task_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id  TEXT NOT NULL,
  at       INTEGER NOT NULL,
  actor_id TEXT,                                        -- NULL: the system (reminders, escalation, dependencies)
  kind     TEXT NOT NULL,
  detail   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_ai_task_events_task ON ai_task_events(task_id, id);

-- Who the Agent Manager may assign work to in a community: members of these roles, and these people. Nobody until an
-- admin says so.
CREATE TABLE ai_task_settings (
  org_id     TEXT PRIMARY KEY,
  roles      TEXT NOT NULL DEFAULT '[]',
  users      TEXT NOT NULL DEFAULT '[]',
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Files a person submitted for a task (uploaded like other AI inputs; not end-to-end encrypted).
ALTER TABLE ai_files ADD COLUMN task_id TEXT;
CREATE INDEX idx_ai_files_task ON ai_files(task_id);

-- The Agent Manager's new tool. Existing installs hold every tool of their skill unless a community removed one; it does
-- nothing until a community names who may be assigned work (ai_task_settings) and the person asking may manage agents.
UPDATE ai_agent_installs SET tools = json_insert(tools, '$[#]', 'tasks.assign')
 WHERE agent_id = 'agent_manager' AND state <> 'uninstalled' AND instr(tools, '"tasks.assign"') = 0;
