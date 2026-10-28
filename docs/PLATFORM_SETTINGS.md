# Platform settings (Platform Admin 2.0, API 0.34.0)

Runtime settings changed from the console (`platform_settings`; super admins, with a fresh passkey check and a
reason). Each change applies at once and is audited with its before and after values. Undo a change by setting the old
value back. Only settings that really change what the server does are here. Secrets never are: AI keys are encrypted in
`ai_providers`, and everything else stays in the server's environment.

| Key | Default | Effect |
|---|---|---|
| `ai.enabled` | off | The AI kill switch: off refuses every AI request before any provider is called |
| `analytics.excluded_users` | none | User ids left out of analytics (load-test accounts always are) |
| `analytics.exclude_admins` | on | Leaves people with a console role out of analytics |
| `alerts.email` | off | Emails new alert incidents to super and operations admins |
| `costs.server_monthly` | unknown | The hosting plan's monthly price and its source, for estimates |
| `costs.transfer_allowance_bytes` | unknown | The plan's monthly transfer allowance and its source |
| `costs.storage_per_gb_month` | unknown | The object storage price per GB-month and its source |
| `costs.egress_per_gb` | unknown | The object storage price per GB transferred out and its source |

Read-only in the console:

- **Experiments:** defined in code, switched by `EXPERIMENTS_MODE` / `EXPERIMENT_STATUS`, so every change is reviewed and deployed.
- **Non-secret environment values:** registration mode, storage backend, analytics and experiments modes, console session settings, whether `PLATFORM_SECRETS_KEY` and `HOST_METRICS_FILE` are set, and the telemetry interval.

Maintenance mode, sign-up switches, blocked email domains and feature kill switches are platform controls, enforced by
the server for every app version: see `docs/PLATFORM_CONTROLS.md`. Service notices are written on incidents and aren't
published automatically.
