# Test record

| Area | Performed | Acceptance still gated |
|---|---|---|
| Storage | AWS identity, stack validation/lint, bucket readback, current and historical versions, tags, metadata, checksum and ordered delete markers. Reran reconciliation with the supplemental disk manifest. Anonymous bucket listing returned 403. | Final fenced delta before primary switch and subsequent disaster-recovery rehearsal. |
| Backend | Final targeted storage, direct upload, media publication, attachments, abuse, quotas, Mongo file store and profile tests: 96 passed across ten files. Real Fastify test checked membership denial, range bytes, worker authentication and grant denial after logout. Worker tests covered GET range, HEAD, path validation and fail-closed redirects. | Matching active production authority, live private authorization, large resumed multipart transfer and currently installed clients. |
| MongoDB | Read-only bounded nested string scan and active attachment reconciliation. | Verify the database after the independent writer transition. |
| Web | Browser CSP check before and after server config; live signed-link proxy configuration reviewed. | Account-level send, download, playback and historical tests against the activated service. |
| Android | Attachment JVM checks and three device instrumentation tests passed on Android 16. | Play-served production artifact and authenticated Frankfurt transfers. |
| Windows | 75 desktop tests passed after fix. Release-payload CSP reproduction and candidate replay; native Windows development installer CI passed. | Signed stable release qualification, published page/feed integrity and user transfer tests. |
| Admin | 32 passed and one skipped in the existing test suite. Reviewed authenticated API flow and dynamic backend diagnostics. | Live administrator file actions and infrastructure display after activation. |
| Storefront | 46 unit and 114 browser tests passed. Static production build, public pages, fixture checkout and actual Windows artifact checked. | Real purchase/capture intentionally not performed; repeat release-specific checks after Windows publication. |
| Status and edge | Unit/monitor/type checks passed. Real TLS, origin range, fixture bytes, negative private GET and independent D1 measurements during API maintenance. | Production private account-to-account playback and post-cutover health. |

The database migration's independently observed outage is not evidence of a storage failure. The real status page rather than the staging reports controls public health.

The architecture-boundary suite also reported two failures. An isolated checkout of the unchanged base reproduced the exact same 31 import and 21 table-access exceptions. Neither allowlist was changed. Report them as pre-existing failures, not passes.
