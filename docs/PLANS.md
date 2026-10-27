# Plans and entitlements (preparation only, 2026-10-19)

> Since API 0.49.0 (2026-10-28) plans, subscriptions and provider events exist: see `BILLING.md`. What follows is the
> original preparation note; `GET /v1/orgs/:id/plan` now answers the plan's name while a subscription grants one.

Meldiq is meant to launch with Free and Premium options, but **no plans, prices or entitlements have been decided**.
This round only adds the one place where such rules will live, so the app and the routes never hard-code them.

- `server/src/entitlements.ts`: the countable capabilities (`integrations.installed`, `integrations.webhooks`,
  `integrations.notifications`, `roles.custom`), checked where those things are added. By default there are no limits.
- An operator may set server-wide limits (`ENTITLEMENT_LIMITS=integrations.installed=10,roles.custom=20`). They apply to
  every workspace equally and are explained in plain words (`409 limit_reached`, with the limit).
- `GET /v1/orgs/:id/plan` (any member): `{ plan: null, source: "none" | "server", capabilities: [...], upgrade: null }`.
  The app's Usage screen shows any limits as they are, and says that no plan is assigned. No upgrade is offered,
  because no subscription flow exists.
- Never gated by a plan: account security, recovery, data export, leaving or deleting, and cancelling.

When plans are approved: add a per-workspace plan record (with its source of truth, e.g. a billing provider), map plan →
limits in this module, and keep the app reading `GET /v1/orgs/:id/plan`. Comparisons must be factual (no invented
reference prices, no urgency or guilt copy).
