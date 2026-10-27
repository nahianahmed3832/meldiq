# AI Workforce: implementation checklist

Design: `AI_WORKFORCE.md`. Built 2026-10-24 on `internal-beta` (uncommitted, like everything since 0.30.0), with the
console in `meldiq_central_admin` and Meldiq Web in `orbit_web` (uncommitted there too).
Baseline before any change: server `tsc` clean, 878 tests passed / 10 skipped; console `tsc` clean, 17 passed.

Legend: [x] done and verified · [~] done, not fully verified · [ ] not done · [B] blocked (reason given)

## Phase 1: audit and design
- [x] Repository, working tree, conventions, E2EE model, existing AI gateway, quotas, audit, console, web app mapped
- [x] Design and privacy decision written (`AI_WORKFORCE.md` §2: agents never hold encryption keys)

## Phase 2: shared foundations (server)
- [x] Migration 049 (additive), table owners, MongoDB catalog mapping (kept in SQLite)
- [x] Model gateway: capabilities, adapters (text, vision, transcription, speech, image generation, embeddings), verification, `auto` routing, fallback across models, circuit breaker, routing decisions in usage rows
- [x] Workforce settings (enabled, paused, max concurrency, approval floor), read live
- [x] Job engine: states, leases, recovery, retries with backoff, deadlines, cancellation, idempotency, dependencies, depth and per-request limits
- [x] Tool gateway: policy → entitlement → grants → skill → live permission and channel → connection → approval → quota; audit
- [x] Files: inputs streamed and sniffed, artifacts, avatars; blob store `ai-files`; SHA-256 read-back; authenticated download
- [x] Media engine (ffmpeg/ffprobe, fixed operations, detection of filters and fonts)
- [x] Guarded web fetch (https, public addresses, pinned connection, redirects re-checked, limits)
- [x] Quota keys `ai.jobs`, `ai.active_jobs`, `ai.media_seconds`, `ai.file_bytes`

## Phase 3: Platform AI Control Center
- [x] Admin API: overview, model capabilities and routing, catalog publishing, tool policies, entitlements, jobs, emergency controls; metadata-only console view
- [x] Console pages (Overview, Providers & keys, Models & routing, Agent catalog, Tools, Communities, Jobs)
- [x] Operator CLI: `ai-workforce-status`, `ai-workforce-pause`, `ai-workforce-resume`

## Phase 4: AI Workforce (communities)
- [x] Community permissions `ai.use` (members by default), `ai.manage`, `ai.approve`
- [x] Catalog, install, customise (name, avatar, colour, description, role, language, style, instructions), grants, execution mode, limits, invokers, disable, upgrade, uninstall
- [x] Channel assignments and activation modes

## Phase 5: Agent Manager
- [x] Answer / ask / delegate; validated plans; delegation as the requester; dependencies; waiting on real jobs; report from records; loop and depth protection

## Phase 6: specialist agents (skills)
- [x] All 21 catalog entries with distinct skills, contracts and deterministic checks (`AI_WORKFORCE.md` §10)

## Phase 7: channels, files, approvals (web)
- [x] Agent posts in channels (not E2EE, labelled), realtime `ai.posts` / `ai.job`
- [x] Web AI agents area: agents and catalog, settings, Agent Manager, requests, approvals, deliverables
- [x] Invocation from a channel (`@Agent` / `/agent` in the composer, the Ask button), consent notice
- [x] Approvals and revisions in the web job view
- [x] Sharing a channel's recent messages with a request, decrypted in the browser, with the notice and a channel post (migration 050; `AI_WORKFORCE.md` §2)
- [ ] Android: agent posts and the AI agents area (not started)

## Phase 7b: operational upgrade (2026-10-24, §5b)
- [x] Console: the key's model list when approving, and one-step "Use for AI agents" (Text on + real verification)
- [x] Readiness checks with who fixes what; Test (a real request); Activity (counts only)
- [x] Autonomy levels manual / assisted / guarded / continuous, enforced; limits (runtime, tries, active hours)
- [x] Durable triggers: schedules, signed webhooks, handoffs; dedupe, loop and chain limits; auto-off after 5 failures
- [x] Agent Manager offers and delegates only to agents that can run (not manual, with a verified model)
- [x] Web: Configure agent in 9 steps (identity, models, skills, channels, permissions, autonomy, triggers, limits, test)
- [x] In production since 2026-10-24 09:30 UTC: API 0.36.0 (migration 051), console 0.4.0, web 0.5.0-beta-ac31d7d (`DEPLOYMENT.md`)
- [ ] Android screens for configure and triggers

## Phase 7c: capability routes (2026-10-24, API 0.37.0, §4)
- [x] Production audit: an OpenAI provider with a key but 0 approved models, so all seven routes were empty; both failed
  jobs (Agent Manager) stopped at routing (`ai_not_configured`) before any provider request, so 0 requests and $0 were correct
- [x] One-step route set-up per category (approve, capability on, real verification, activate only if passed)
- [x] Verification checks the output type (text, the test image's colour, transcript, MP3, image bytes, finite vectors) and names the next step
- [x] Route states (ready, not configured, untested, failed, unavailable, disabled) with last verification and last request
- [x] A new or removed key clears its models' verifications; requests no route can serve are refused, not queued
- [x] Failed-job diagnosis and recovery in the console; failed-before-model jobs and verification requests counted apart
- [x] All seven routes set up and verified with real OpenAI requests (2026-10-24): gpt-6.1-sol for reasoning, quick replies
  and image understanding; whisper-1, gpt-4o-mini-tts, gpt-image-2, text-embedding-3-small for the media routes

## Phase 8: verification
- [x] Server tests: `ai_workforce_acceptance`, `ai_workforce_runtime`, `ai_workforce_skills`, `ai_gateway` (plus updated architecture, permissions, sweep, contracts suites)
- [x] Acceptance scenario end to end (fake provider, real ffmpeg)
- [x] Full server suite, console and web unit tests, lint, type checks, builds; console and web browser tests (Chromium)
- [B] Real provider verification: no provider key on this machine. Configure one in the console and verify each capability there.
- [B] Docker image build: Docker isn't installed on this machine. Build it on the VPS (or CI) and check the console's media engine line.

## Phase 9: deployment readiness
- [x] Dockerfile installs ffmpeg and a font; configuration, deploy and rollback documented (`AI_WORKFORCE.md` §9, §14)
- [x] Server 0.35.0 and console 0.3.0 in production since 2026-10-24 06:22 UTC (`DEPLOYMENT.md`), AI Workforce switched off
- [x] Meldiq Web 0.5.0-beta-e41839b in production since 2026-10-24 06:54 UTC (ported onto `origin/main`, branch `ai-workforce-web`, not merged yet)
- [x] Workforce routes in the route contracts (`shared/contracts/http/aiWorkforceRoutes.ts`), checked by the suite

## Remaining work, in order
1. Owner decisions: whether agents may ever read channel history (changes the E2EE promise; proposal in
   `AI_AGENT_CHANNEL_READ_PROPOSAL.md`), and which outside connectors to build first.
2. In the console, Set up each of the seven routes with real models (Models & routing); publish agents; run the video scenario with real footage.
3. Build the image on the VPS and confirm the media engine line (burned-in captions and text overlay need Alpine's ffmpeg to have `subtitles` and `drawtext`).
4. Android: render agent posts in channels and add the AI agents area (with sharing recent messages, as on the web).
5. Connectors for external actions (each with its own approval flow), PDF text extraction.
