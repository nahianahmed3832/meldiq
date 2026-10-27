# AI removed (API 0.47.0, 2026-10-28)

The owner decided Meldiq is a community app without AI ("current model no use for community style"). API 0.47.0 removes
AI provider connections (the AI gateway) and AI Workforce (agents, jobs, tasks, readers, triggers, skills, system
checks) from the server, the web app and the Platform Admin Console API. Their old documents are in `docs/retired/`.

## What changed

- No AI routes: `/v1/orgs/:orgId/ai/…`, `/v1/conversations/:id/ai/…`, `/v1/ai/hooks/…` and `/admin/v1/ai/…` answer 404
  (not registered). No AI job runner, no `ai.*` realtime frames, feature `ai-workforce` no longer advertised.
- Community role permissions `ai.use`, `ai.manage`, `ai.approve` are gone (stored roles never held them in production;
  unknown permissions are skipped when roles load). Platform console permissions `ai.*`, the `ai.*` platform settings,
  the AI alert rule, the AI usage export, the `ai.*` quota keys and the `ai-workforce-*` CLI commands are gone.
- Messages are never encrypted to an AI agent again: the device directory lists people only, and the server no longer
  accepts agent reader devices as recipients. Agent accounts (`users.kind = 'agent'`) are left out of member lists.

## What stays (on purpose)

Nothing was deleted from the database: the 26 `ai_*` tables, the agent account and the `ai.*` platform settings rows
stay as they were, unread. Dropping them would be a destructive change that needs its own backup-verified migration
and the owner's decision. At removal production had 16 agent installs, 8 jobs and 6 agent posts, 1 agent account in 1
conversation, and no active agent device (so nothing was being encrypted to agents).

The Platform Admin Console's AI pages (meldiq_central_admin) now get 404 from the API; that project isn't in this
repository and was left unchanged.

The web app's "Translate" (Chromium's on-device translator) isn't part of this: it runs in the browser and sends
nothing to Meldiq or anyone else.

## Rolling back

API image `0.46.0` (rollback tag) still has AI; with it, the kept tables and settings make AI work as before.
