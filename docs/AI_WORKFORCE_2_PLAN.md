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

## Order of work

Phases follow the brief's order, starting with what no decision blocks: (1) shared skill library and discovery,
(4) human tasks and Manager orchestration, (10) cost controls; then the decision-dependent phases.
