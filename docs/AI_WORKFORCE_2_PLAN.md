# AI Workforce 2.0: audit, gaps and plan (2026-10-24)

The owner's "Autonomous AI Workforce 2.0" brief, checked against this repository (`internal-beta` `da4268f`, API
0.37.1). Each area: what exists, what's missing, and what blocks it. Nothing here is built yet unless marked done.

## Constraints that shape everything

- **Messages and attachments are end-to-end encrypted.** The server (and every agent on it) never sees channel
  messages, channel files, or mentions. Agents see only what a person submits to them (brief, files uploaded to the
  request, messages shared with a request since 0.35.0) and their own posts. Reading channels needs the owner's
  decision (`AI_AGENT_CHANNEL_READ_PROPOSAL.md`).
- **There are no connectors.** The 2026-10-21 community rebuild removed the app directory, OAuth connectors, webhooks,
  the Unified Inbox and workflows (`COMMUNITY_REBUILD_2026-10-21.md`); their tables are retired (`retiredData.ts`).
  Every external tool (`social.publish`, `ads.manage`, `website.update`, `email.send`…) answers
  `integration_not_configured`. GriipBuddy's store, orders and inventory are not in Meldiq.
- **No human task system.** Meldiq has no task or assignment records (reminders are personal and encrypted).

## Area by area

| # | Area | Exists | Missing | Blocked by |
|---|---|---|---|---|
| 1 | Skill discovery and library | 21 agents, each bound to exactly one skill (`SkillDef` in `AgentDef`); tool registry with risk and per-platform policy; readiness per install | A shared, versioned skill registry separate from agents; discovery by capability; composition; missing-capability reports; skill installation workflow | — (buildable now) |
| 2 | Setup wizard | Web 9-step Configure agent (0.36.0): readiness, autonomy, channels, limits, real test | Integration onboarding (OAuth, scopes, validation) and per-integration readiness states | Which integrations (decision 2–3) |
| 3 | Business knowledge | Knowledge skill: keyword ranking over submitted files; embeddings route verified but unused | Workspace knowledge base; retrieval with sources and freshness; product, order, inventory data | Where GriipBuddy's business data lives (decision 2); vector store |
| 4 | Manager and human tasks | Agent Manager plans, delegates to installed agents (depth 2, job caps), waits, reports | Human task records, assignment, reminders, evidence of completion, reallocation, workforce report | — (buildable now; task records are server-stored, not end-to-end encrypted) |
| 5 | Agents in channels | Assigned channels, mention activation, AI-badged posts, member-list section, loop-safe (agents never read posts) | Reading channels (assigned or workspace-wide), DMs, event activation from messages | Decision 1 (end-to-end encryption) |
| 6 | Event and scheduled workflows | Durable triggers: schedules, signed webhooks, handoffs; leased worker that survives restarts | Business events (new order, low stock) | A connected business system (decision 2) |
| 7 | Video pipeline and Mac companion | Product Video Editor: probe, transcribe, edit plan, ffmpeg render, verified outputs | Production briefs as tasks; footage submitted to a task (server sees it only when submitted to AI, not as a channel attachment); Mac companion | Decision 4 (editor); companion is a separate signed macOS app |
| 8 | Social and website operations | Tool stubs with approval policy | Real connectors, publishing, post verification, site checks | Decision 3 (platforms) and the owner's developer-app registrations |
| 9 | Performance marketing | `ads.manage` stub; quota engine with hard cost limits | Ad-account connector; a spend ledger enforced in code across agents | Decision 3; Meta/Google ads API access needs business verification |
| 10 | Model routing and cost | Gateway, 7 verified routes, quotas (requests, tokens, cost), per-agent limits, usage per job | Per-job and per-agent monthly cost caps in the UI, prompt caching, batch work, cost per completed task | — (buildable now) |
| 11 | Web and mobile admin | Web config, console ops; Android: ask sheet and agent bits | Android configuration, approvals, task status, emergency pause | After 1–10 settle |
| 12 | Tests | 984 server tests, console and web browser tests | Acceptance tests listed in the brief | Grows with each phase |

## Owner decisions (2026-10-24)

1. **Channel reading: opt-in AI reader per channel.** An admin turns it on for a channel; the reader joins as a member
   device, everyone in the channel is told, and only messages from then on are readable to agents. Other channels stay
   end-to-end encrypted as before (design: `AI_AGENT_CHANNEL_READ_PROPOSAL.md`).
2. **Business data: GriipBuddy's own website** (griipbuddy.com: a custom Node.js and MongoDB system with a Next.js
   front end; corrected by the owner: the Active eCommerce/Laravel package in `griipbuddy_codebase` is an older codebase,
   not the store). Its source isn't on this machine (GriipOS hit the same gap: `griip_os/docs/griipbuddy-provider.md`),
   so agents read it only once the owner provides the repository or its API, and a read-only access path (a read-only
   MongoDB user or a service API key). Nothing is copied into Meldiq. Related systems to reuse rather than duplicate:
   **GriipOS** (integration engine, encrypted credentials, read-only Meta and TikTok marketing data) and **GriipBuddy
   Engage** (Instagram, Facebook and Messenger engagement; built and tested, not live). The employee-management app
   (Next.js and PostgreSQL) isn't deployed, so human tasks live in Meldiq for now.
   *Owner, 2026-10-24:* the store's code lives only on its server (griipbuddy.com is behind Cloudflare, origin not
   known here: the owner names the server and folder); agents read it through a **read-only MongoDB user** the owner
   creates.
3. **Platforms: Facebook and Instagram, TikTok, YouTube and Google Ads.** Each needs a developer app the owner
   registers (Meta business verification and app review; TikTok app review; a Google Cloud project and an Ads developer
   token). Publishing and ads stay off until those exist and pass their checks. Built **inside Meldiq** (owner's choice), reusing
   the GriipOS and Engage designs and code where they fit.
4. **Video: mostly on the owner's Mac with Filmora and CapCut, the server as a fallback.** Neither editor has a
   scripting API, so the Mac companion drives them through macOS accessibility with an allowlist (the least reliable
   kind of automation; every result is checked as a real file). When the Mac is offline, an agent asks the owner
   before using the server's ffmpeg editor instead.

## Phase 1: shared skill library and discovery (done, API 0.38.0, not deployed)

- `workforce/capabilityCatalog.ts`: 41 machine-readable capabilities, what each of the 21 skills provides, and which
  outside tool or model route a capability needs beyond its skill's own (a leaf module, so skills can use it).
- `workforce/skillLibrary.ts`: a card per skill (inputs and outputs as JSON Schema, tools with risk, models, files,
  limits, approvals, errors, tests) and `discover()`: for each needed capability, the community's agents that provide
  it, whether each can do it now for the person asking (readiness, who may use it, the capability's tool and routes),
  the exact blocker otherwise, and the catalog agents to install.
- `GET /v1/orgs/:orgId/ai/skills` and `GET /v1/orgs/:orgId/ai/skills/discover?capabilities=…` (members).
- Agent Manager: one quick-replies call names the capabilities a request needs; discovery runs before planning; what
  nobody can do is left out of the plan and reported with its blocker (`output.missing`, the answer and the report).
- Tests: `ai_skill_library.test.ts` (5). Not built yet: installing skills from outside sources, administrator-defined
  skills, an agent running another agent's skill (each skill still belongs to its agent; reuse is by delegation).

## Phase 4: human tasks and Manager-led orchestration (done, API 0.39.0)

- Migration **052**: `ai_tasks` (state, assignee, creator, request, channel, priority, due time, dependencies,
  references, reasons, notes, reminders, escalation), `ai_task_events` (every change, who and when),
  `ai_task_settings` (who the Agent Manager may give work to: roles and people; nobody until an admin says so),
  `ai_files.task_id` (what people hand in). Existing Agent Manager installs get the new `tasks.assign` tool.
- Lifecycle: waiting → open → accepted → in progress ⇄ blocked → submitted → done, or returned to in progress; cancel
  and reassign. Only the assignee accepts, starts, blocks and submits; a submission needs a note or files (their own
  uploads); only the creator or someone with "Manage AI agents", never the assignee, approves or returns.
- Agent Manager: plans "person" steps beside agent steps, only when the person asking may manage agents and someone is
  eligible. The server chooses who (the role named, then the fewest active tasks), never the model. An agent step can
  wait for a person's task and reads what they handed in; a person's task can wait for agent steps and gets their
  deliverables as references. The Manager waits on tasks like jobs and reports who did what.
- Worker: opens waiting tasks when their agent steps finish (cancels them when those fail), reminds assignees a day
  before and after the due time (at most daily), and tells the creator once after two reminders on an overdue task.
- API: `GET/POST /v1/orgs/:orgId/ai/tasks` (mine, created, or all with the workforce report), `GET …/tasks/:taskId`,
  `POST …/tasks/:taskId/{accept,start,block,submit,approve,return,cancel,reassign}`, `GET/PUT …/tasks/settings`;
  realtime `ai.task`. Tests: `ai_tasks.test.ts` (5).
- Not built: availability calendars (none exist in Meldiq; the employee-management app isn't deployed), push
  notifications for tasks (realtime and channel posts only), an agent reviewing a submission against its criteria.

## Phase 5: agents as channel members (design, 2026-10-25)

The owner's "native AI bots" brief, on top of decision 1 (opt-in AI reader). Design follows
`AI_AGENT_CHANNEL_READ_PROPOSAL.md` with these choices:

1. **One bot identity per installed agent** (a `users` row with `kind = 'agent'`, reserved username, the install's name
   and avatar; no account, so it can't sign in, be searched, DMed by others or added anywhere), and **one reader device
   per conversation** (`devices.reader_conversation_id`). A conversation's key list shows an agent only its own device
   for that conversation, so one leaked device key opens one channel, as in the proposal, while members see one bot.
2. **Keys** (identity seed, device signing and encryption keys) are generated on the server and sealed (AES-256-GCM)
   under a random per-reader key, itself wrapped by a key derived (HKDF, own label) from `PLATFORM_SECRETS_KEY`: no new
   production secret. Honest limit: the worker runs in the API process, so the separation the proposal wanted between
   the HTTP process and the key holder doesn't exist; a database leak or a stolen backup still can't open them.
   Switching off deletes the per-reader key (crypto-shred), revokes the device and erases the context.
3. **Consent is enforced by senders' clients.** The server requires every human device and treats reader devices as
   optional (§6.4). A conversation's key list includes reader devices only for clients that say they implement the
   notice and the choice (`x-meldiq-ai-reader: 1`); older web and Android clients never see them, so they never share.
   Each member's *share* / *keep* choice is stored per reader so their devices agree.
4. **Replies stay agent posts** (server-stored, AI-badged, in the channel or thread), as since 1.0: agents never send
   end-to-end encrypted messages, so no client has to trust an agent's signature, and an agent never reads another
   agent's output (no loops through messages).
5. **What triggers an agent** in a channel it reads and is assigned to: a mention of its bot account, a command
   (`/name …`), a reply in the thread of one of its posts, or every message in a direct conversation with it. Each
   message triggers at most one job per agent (`msg:<messageId>`), with a per-channel cooldown; messages from agents
   are ignored.
6. **Read and write are separate.** Reading needs a reader in that channel; posting needs the existing channel
   assignment. "Read all channels" creates a reader, with its notice, in every channel of the community.
7. **Direct conversations with an agent** are DMs between a person and the bot account; starting one is the person's
   consent, so everything they write there is shared.
8. Open questions of the proposal, defaults taken (owner can change): sharing is never required to post (members keep
   their opt-out); context window 30 days / 2,000 messages; any verified provider (no "no retention" flag yet);
   channel attachments are not read (files reach agents through requests and task hand-ins); the notice names the
   provider of the route in use.

**Built (2026-10-25):** stage A, API 0.40.0 (internal-beta `08965b1`, `de97578`): migration 053, the reader worker,
triggers, grants, direct conversations, the recipient rule; tests `ai_channel_readers` (13, real end-to-end crypto
between the reference client and the server's reader) and `ai_creative_workflow` (real ffmpeg). Stage B, web
(orbit_web `08ba69d`): notice and choice, the wrap rule, `@`/`/` suggestions, direct conversations, reading settings;
browser test included. Not built yet: stage C (Android: it never sees a reader, so its members never share and see no
notice), channel attachments, a "watch and triage" activation, cancelling a reader's running jobs at switch-off.

Stages: (A) server: identities, reader devices, recipient rule, worker, triggers, grants, DMs, tests with real crypto;
(B) web: notice and choice, wrap rule, commands, DMs, settings; (C) Android: the same; (D) staged rollout behind the
platform setting `ai.workforce.channel_reading` (off by default).

## Order of work

Phases follow the brief's order, starting with what no decision blocks: (1) shared skill library and discovery,
(4) human tasks and Manager orchestration, (10) cost controls; then the decision-dependent phases.
