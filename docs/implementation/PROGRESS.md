# Autonomous AI Workforce: engineering journal

The owner's "Meldiq Autonomous AI Employee Platform" master prompt (2026-10-25), worked phase by phase (its §16).
Newest entries first within each phase. Capability statuses: `CAPABILITY_MATRIX.md`. Material decisions: ADRs in
`../decisions/` (index there) and the earlier AI Workforce design in `../AI_WORKFORCE.md` and `../AI_WORKFORCE_2_PLAN.md`.

**Rule for this work: no deploys.** Everything is committed locally on `internal-beta` (server, Android, shared) and
`ai-workforce-web` (Meldiq Web worktree). Production stays at API 0.40.0, web 0.5.0-beta-08ba69d, console 0.5.0 until
the owner approves a release.

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
