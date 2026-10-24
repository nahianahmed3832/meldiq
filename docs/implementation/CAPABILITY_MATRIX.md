# Capability matrix (2026-10-25)

What the AI workforce can do today, honestly classified. Updated at each phase gate (`PROGRESS.md`).

- **verified**: automated tests pass on the current code with nothing but outside providers faked, including a browser
  test where there's a UI.
- **implemented_unverified**: built, but proven only with a fake for something that matters (an outside API), or not
  exercised end to end.
- **partial**: some of it exists; the gap is named.
- **blocked_external**: needs something only the owner or a third party can provide (named).
- **not_implemented**: not built.

"Live" says whether production runs it (API 0.41.0, web 0f42277, console 0.6.0 since 2026-10-24 19:30 UTC).

## Core workforce

| Capability | Status | Live | Evidence / gap |
|---|---|---|---|
| Model gateway, 7 routes (reasoning, fast, vision, speech-to-text, text-to-speech, image, embeddings) | verified | yes | `ai_route_setup.test.ts`; each route checked against OpenAI in production (2026-10-24) |
| Agent catalog, install, configure, readiness, autonomy | verified | yes | `ai_workforce_*.test.ts`; web e2e "configures an agent step by step" |
| Job engine: queue, leases, retries, idempotency, dependencies, recovery | verified | yes | `ai_workforce_runtime.test.ts` |
| Ask an agent (dialog) and channel posts with AI badge | verified | yes | web e2e |
| Channel "@Agent" anywhere in a message, "/command" | verified | yes | ADR 0008; shared cases on server, web, Android; web e2e. Before: start of message only |
| Agent Manager: answer, ask, delegate, report from records | verified | yes | `ai_workforce_runtime.test.ts`, `ai_creative_workflow.test.ts`, `ai_tasks.test.ts` |
| Manager reports only what other agents can't do | verified | yes | fix `8601242` |
| Skill library and discovery (provides, blockers, installable) | verified | yes | `ai_skill_library.test.ts` |
| Human tasks: assign, hand in, accept, Manager steps for people | verified | yes | `ai_tasks.test.ts`; web e2e "tasks for people" |
| Triggers: schedules, signed webhooks, handoffs | verified | yes | `ai_workforce_automation.test.ts` |
| Approvals and emergency pause | verified | yes | runtime tests; console |
| Agents reading channels (opt-in readers, member choice, crypto-shred) | verified | off | `ai_channel_readers.test.ts` (real crypto); deployed with `ai.workforce.channel_reading` off |
| Direct conversation with an agent | verified | off | same; needs channel reading on |
| Android: ask sheet, channel agents, invocation rule | partial | yes | no configuration, approvals or task screens; readers (stage C) not built |
| Mention inside a thread reply (apps) | not_implemented | — | apps intercept top-level messages only |

## Operations and visibility

| Capability | Status | Live | Evidence / gap |
|---|---|---|---|
| Console AI control center (overview, routes, models, jobs) | verified | yes | console tests; used in production |
| Full System Check (one run, all subsystems, history, export) | verified | yes | `ai_system_check.test.ts`; web and console e2e; first production run 21 healthy, 1 warning |
| Work overview (what needs you, in progress, finished, failed, cost; links to records) | verified | yes | `ai_work_overview.test.ts`; web e2e "Overview…"; Android not yet |
| Business goals/objectives as records with execution plans | not_implemented | — | no goal model; Manager plans per request only |
| Cost accounting: quotas on requests, tokens and cost, usage per job | verified | yes | operator quotas; cost per request in the work overview |
| Per-agent monthly AI budget, hard-enforced | verified | yes | `ai_agent_budget.test.ts`; web e2e; migration 055 |
| Token efficiency: fast route for classification, context limits | partial | yes | no prompt caching, no batching |

## Business integrations

| Capability | Status | Live | Evidence / gap |
|---|---|---|---|
| Social publishing (Facebook, Instagram, TikTok, YouTube) | blocked_external | — | developer apps and app review (owner); tools answer `integration_not_configured` |
| Social engagement and analytics | blocked_external | — | same |
| Ads with spend ledger (Meta, Google Ads) | blocked_external | — | business verification and Ads developer token; no ledger yet |
| GriipBuddy store data (products, orders, inventory), read-only | blocked_external | — | read-only MongoDB user and the server's location (owner) |
| Courier, COD, procurement | not_implemented | — | waits on store access |
| Email sending | not_implemented | — | no provider connected for agents (platform email is for accounts) |
| Knowledge from submitted files (keyword ranking) | verified | yes | `ai_workforce_skills.test.ts` |
| Workspace knowledge base with embeddings | not_implemented | — | embeddings route verified, unused |

## Media

| Capability | Status | Live | Evidence / gap |
|---|---|---|---|
| Server video editing (probe, transcribe, plan, ffmpeg render, checked outputs) | verified | yes | `ai_creative_workflow.test.ts` with real ffmpeg |
| Images (generation) and speech | verified | yes | routes verified in production |
| Mac companion driving Filmora / CapCut | not_implemented | — | a separate signed macOS app; neither editor has a scripting API |

## SaaS

| Capability | Status | Live | Evidence / gap |
|---|---|---|---|
| AI entitlements per community, quotas | verified | yes | console tool policies, entitlements |
| Subscriptions, billing, usage metering for customers | not_implemented | — | no billing provider, plans or payments (`platformAdmin/billing.ts` says so); operators set limits |
