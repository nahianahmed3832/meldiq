# Autonomous AI Workforce: engineering journal

The owner's "Meldiq Autonomous AI Employee Platform" master prompt (2026-10-25), worked phase by phase (its §16).
Newest entries first within each phase. Capability statuses: `CAPABILITY_MATRIX.md`. Material decisions: ADRs in
`../decisions/` (index there) and the earlier AI Workforce design in `../AI_WORKFORCE.md` and `../AI_WORKFORCE_2_PLAN.md`.

**Rule for this work: no deploys.** Everything is committed locally on `internal-beta` (server, Android, shared) and
`ai-workforce-web` (Meldiq Web worktree); the console (`meldiq_central_admin`, not a git repository) is changed in place.
Production stays at API 0.40.0, web 0.5.0-beta-08ba69d, console 0.5.0 until the owner approves a release. Prepared:
API 0.41.0 (migrations 054 and 055, both additive), console 0.6.0.

## Where things are

| What | Where | Checks |
|---|---|---|
| Server (Fastify, TypeScript, better-sqlite3) | `meldiq_android/server` | `npx tsc --noEmit -p .`, `npm run lint`, `npx vitest run` |
| Shared contract and rule fixtures | `meldiq_android/shared/contracts/fixtures` | server `test/contracts.test.ts`; web and Android decode the same files |
| Android (Kotlin, Compose) | `meldiq_android/android` | `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew :app:testDebugUnitTest` |
| Meldiq Web | `orbit_web/.claude/worktrees/ai-workforce-web` (branch `ai-workforce-web`, PR #20) | `npm run typecheck` (`tsc -b`; `tsc -p .` checks nothing), `npm run lint`, `npm test`; e2e: `ORBIT_SERVER_DIR=…/server npx playwright test e2e/agents.spec.ts --project=chromium` after `npm run build` in the server |
| Web contract copy | `test/contract-fixtures` | `MELDIQ_CONTRACTS_DIR=…/meldiq_android npx tsx scripts/sync-contract-fixtures.ts` (copies what's *committed*) |
| Platform console | `meldiq_central_admin` (not a git repository) | `npx tsc --noEmit`, `npx vitest run` |

Production data store is SQLite; there is no MongoDB in Meldiq (MongoDB is GriipBuddy's store, reached read-only).

## Phase 0: baseline and root-cause audit (2026-10-25)

- Baseline: server 1010 tests passed / 11 skipped before this work; web 467 passed; agents e2e 10/10.
- The earlier audits stand and aren't repeated: `../AI_WORKFORCE_2_PLAN.md` (area-by-area gaps, owner decisions,
  constraints: end-to-end encryption, no connectors since the 2026-10-21 rebuild) and `../AI_WORKFORCE_PROGRESS.md`
  (the 1.0 build checklist).
- Highest-priority defect: the owner's report (2026-10-25) that "@Agent Manager" in a channel answered, then said
  "Answer questions: no agent here does it; install Agent Manager or General Assistant." Two causes, below.

## Phase 1: core invocation and reliability (2026-10-25)

**Root causes**

1. *The Manager reported itself missing.* Before planning, it classifies what the request needs and asks discovery
   (`skillLibrary.ts discover`) who can do each capability. Discovery leaves out the asking install, so a plain question
   (`text.answer`, which the Manager provides itself) came back "no agent here does it". Not a second-assistant
   requirement and not a channel-handler difference: direct requests had the same flaw.
2. *A mention not at the start of a message never reached an agent.* Web and Android intercepted "@Agent" only as a
   message's first word; "…token uses @Agent Manager" went out as an ordinary end-to-end encrypted message no agent can
   read (channel reading is off on the platform). The server's readers matched a mention anywhere but accepted only
   "/agentmanager", while the apps offer "/agent-manager". Three copies of the rule had drifted.

**Changes**

- `server/src/modules/workforce/catalog/skills/manager.ts`: the Manager's own capabilities (`SKILL_PROVIDES`) are left
  out of the check. Test: `ai_skill_library.test.ts` "answers a plain question itself, with no other agent installed"
  (fails before the fix with exactly the reported line).
- `server/src/modules/workforce/invocation.ts`: the one rule (ADR 0008). The reader worker uses it. Web
  `src/sync/agentRules.ts` and Android `data/ai/AgentRules.kt` mirror it, and all three test against
  `shared/contracts/fixtures/rules/agent-invocation.json` (18 cases, the reported message first). The contracts test
  validates the file.
- `ai_channel_readers.test.ts`: the apps' dashed command and a trailing mention start jobs, with the call left out of
  the brief.

**Verified (commands run against this code)**

- Server: `tsc` clean, lint clean, 1029 passed / 11 skipped.
- Web: `tsc -b` clean, lint clean, 483 passed; agents e2e 10/10 (channel mention, commands, direct conversation with a
  reader).
- Android: `AgentRulesTest` 8/8 (shared cases included), `ContractFixturesTest` 3/3.

**Gate status:** a permitted channel mention (anywhere in the message) produces a real job and answer in the e2e;
direct conversations still work; an `explicit` agent and a command-only agent's mention don't match (shared cases),
and calls fail closed for people outside an agent's invoker roles, another community's agent and channels the person
can't post in (`ai_workforce_runtime.test.ts`, unchanged). Not deployed.

**Left open:** a mention inside a thread reply isn't intercepted by the apps (the composer only intercepts top-level
messages; in a reading channel the server reader handles it). Android's change isn't on a device build yet.

Commits: `8601242`, `6554bb5` (internal-beta); web: see the `ai-workforce-web` log.

## Phase 2: unified health diagnostics (2026-10-25)

**Outcome:** a community admin (AI agents › Health) or a console operator (AI Control Center › System check) runs one
check and sees what is healthy, failed, needs attention, isn't set up or couldn't be tested, with evidence, cause,
remediation, owner and links to the jobs, tasks, agent or triggers involved. History is stored; reports export as JSON.

**Reused:** agent readiness (`readiness.ts`: the rules jobs run under), route status and last execution
(`ai/routing.ts`), the runtime's tick stats, quota engine, trigger store, the shared invocation rule (phase 1).

**Built** (`server/src/modules/workforce/health/`, migration 054 `ai_system_checks`, API 0.41.0):
- Configuration: switches, each agent, channel assignments, triggers, model routes (all 7 for the platform; the ones
  installed agents need for a community), catalog, secrets key, channel reading.
- Runtime: worker heartbeat, due-job backlog, jobs whose lease expired, failures in 24 h by error code (with what to do),
  approvals waiting over a day, overdue or blocked tasks, usage limits, readers falling behind, disk space.
- Smoke (real, side-effect free): database write/read/rollback, AI file store round-trip with SHA-256 and delete,
  `ffmpeg` start, the invocation rule (platform: fixed messages; community: every agent in every channel, which catches
  two agents a channel can't tell apart). The end-to-end job path is proved only by a real completed job in the last 7
  days; otherwise `not_tested` (a live test costs tokens and posts: use Configure › Test).
- Never calls an AI model, sends, publishes or spends. A check that throws becomes a failed item; the rest run.
- Platform check also runs every 6 hours from the worker's tick (one retry per 10 minutes if it fails). Newest 50
  reports kept per scope. Running is rate-limited (6 per minute per person).
- Web: `src/sync/systemCheck.ts`, `src/ui/agents/SystemCheckTab.tsx` (Health tab, managers only). Console:
  `src/ui/pages/ai/AiSystemCheck.tsx` (System check tab, `ai.view`), schemas generated from `platformAdminWorkforce.ts`.

**Found while building:** with the kill switch off, the first version reported all seven routes as failed with "set up
a model"; now they're `not_tested` and the switch is reported once (test added).

**Verified**
- Server: `tsc` clean, lint clean, 1041 passed / 11 skipped; `ai_system_check.test.ts` 12 (real storage, database,
  invocation; fake provider for the failure and circuit cases; console schemas validated against live answers).
- Web: `tsc -b`, lint, 483 unit tests; agents e2e 11/11 including "Health"; contract test proven to catch a wrong path.
- Console: `tsc -b`, lint, prettier, 17 unit tests, e2e 5/5 including the System check step and phone width.

**Not done here:** event-driven checks beyond the schedule (e.g. on a burst of failures); automatic repair (only the
runtime's existing lease recovery runs); community checks on a schedule. Integrations (social, ads, store) have no
connection to check yet: their tools are reported through each agent's readiness as needing a connection.

Commits: server `173b435`, `2a88c5b`; web `2b07d14`.

## Phase 3: business control center and work center (2026-10-25)

**Outcome:** AI agents now opens on **Overview**: what needs you first (approvals you may give, an agent's question,
your new or overdue tasks, work handed in for you to review), then what agents and people are doing, what failed and
finished in the last 7 days, deliverable counts and the estimated AI cost; managers also see the latest System Check
with a link to Health. Every item opens its record (a request in place, with its approval or question; a task in Tasks).

**Built:** server `workCenter.ts`, `GET /v1/orgs/:orgId/ai/work` (one query family over jobs, tasks, approvals, files
and usage; managers see the community, others their own; approvals follow the Approvals tab's visibility rule). Web
`src/sync/work.ts`, `src/ui/agents/WorkTab.tsx`; Tasks can open a given task.

**Verified:** server 1046 passed (`ai_work_overview.test.ts` 5: costs from real usage records with a priced fake
model, attention for assignee vs creator, retry-waiting shown with its error then failed, visibility between members,
approvals only for approvers); web 484 unit, agents e2e 12/12 (new "Overview…" test; older flows open Agents).

**Decision:** the overview is the first tab of the existing AI agents page, not a new app or navigation tree (§3.1 says
adapt the existing UI). The master prompt's ten-section navigation (Marketing, Business Operations, Integrations…) is
not built: those sections have no connected systems behind them yet, and empty sections would be decorative.

**Not done:** Android shows none of this yet (the endpoint is shared; Android UI belongs to the Android session);
objectives/goals as records (no goal model exists; the Agent Manager's plans are the closest thing).

Commits: server `e70e0a6`; web `45fed81`.

## Phases 4–11: what was safe to do now (2026-10-25)

| Phase | Done in this session | Waiting on |
|---|---|---|
| 4 Skills, setup, business context | Readiness now includes the agent's budget; the System Check aggregates readiness for every agent (phase 2). Skill library, discovery and the 9-step Configure (with a real test) already existed (0.36.0–0.38.0). | Integration onboarding needs the outside accounts (phase 6, 8, 9). A workspace knowledge base needs a vector store decision; the embeddings route is verified but unused. |
| 5 Delegation | Unchanged: the Manager's validated plans, delegation as the requester, depth and job caps, waiting on tasks (0.39.0). | — |
| 6 Social | Nothing new. | Meta (business verification, app review), TikTok (app review), Google Cloud project and Ads developer token: the owner registers these. Tools answer `integration_not_configured`. |
| 7 Video | Nothing new: server editing is verified with real ffmpeg. | The Mac companion (Filmora/CapCut via accessibility) is a separate signed macOS app. |
| 8 Commerce | Nothing new. | GriipBuddy store: a read-only MongoDB user and the server's location (owner). |
| 9 Marketing budgets | The per-agent hard budget (below) is the enforcement an ads agent would run under. | Ad-account connections (as phase 6). |
| 10 Cost | **Per-agent monthly AI budget**, enforced in code (below). | Prompt caching and batching: not started. |
| 11 SaaS | Nothing new. | Pricing, plans and a payment provider are the owner's decisions (§1.2: no billing changes without authorization). |

### Phase 10: per-agent monthly AI budget

People who manage agents set a monthly budget (USD) per agent under Configure › Limits (migration 055, additive:
`ai_agent_installs.max_cost_micro_month`, and an `ai_usage(install_id, at)` index). Spend comes from the usage records
(`ai_usage.install_id`) for this calendar month (UTC). Once it's used up, new jobs are refused (`quota_exceeded`, with
how much of what was used and when it resets) and a running job stops before its next model request. One request
already in flight may finish past the budget. Readiness shows it (advice from 80%, missing when used up), so the System
Check and the agent's Configure page both say why the agent stopped.

**Verified:** server 1050 passed; `ai_agent_budget.test.ts` 5 (exact costs with a priced fake model; the in-flight stop
is proven red without the runtime check); agent-view fixtures re-recorded; Android `ContractFixturesTest` 3/3 on them;
web 484 unit, agents e2e 12/12 (the configure flow sets a $5 budget and readiness shows it).

Commits: server `054367c`; web `0f42277`.
