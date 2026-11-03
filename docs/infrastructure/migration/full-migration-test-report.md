# Test record

Final release b7bffce7 passed 26 tests across four suites on isolated PostgreSQL. The original 0.2.0 Electron renderer completed its real Frankfurt upload through /v1/_meldiq-upload with HTTP 200, ETag and zero CSP violations. Public authenticated retrieval returned the expected bytes. One earlier non-versioned path failed in the packaged shell and was replaced. Live multipart testing on the synthetic free account hit its plan limit. Multipart resume/completion passed against the private Frankfurt S3 test bucket. This is not a claim of native GUI coverage for every client.

## Migration record

| Area | Performed | Limit at that staging checkpoint |
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

The exact Atlas-based candidate 510f6e1f4c4439b41c1a61639434c22e9445e6e0 builds on live image revision 708353fe. Its 97 targeted tests passed. Its scope includes preserving previously issued upload sessions and retry-safe promotion from the old origin.

The first live Frankfurt S3 suite passed nine of ten tests from the workstation; the 11 MiB multipart transfer timed out at 180 seconds. In an isolated container on the application host, the full S3 suite passed all ten against the separate private Frankfurt test bucket, using its scoped test identity and the existing SQLite test configuration. This includes multipart resume, authorized downloads, private ranges, HEAD, conditional 304, cleanup and persistence. The test identity was deactivated after the run. Real production bucket credentials were tested independently by promoting only a known synthetic attachment and retrying its conditional copy. The private edge grant path still requires verification against the activated live API.

The upstream desktop updater qualification passed in native Windows automation. Readback of the stable feed from the operator network was intermittent. Independent HTTPS retrieval from the application host and offline verification with the desktop's pinned signature verifier matched the entire installer, both hashes, sequence and download link. The public storefront's final tests passed after updating the exact expected release link and current Plus catalog fixtures.

## Final production qualification — supersedes staging gates

The selected PostgreSQL runtime extends accepted release f2f7c6c3. Its exact source passed type checking, 19 local media tests and 24 tests against isolated PostgreSQL, including the database activation guards. The Atlas-only build was never deployed. The production traffic fence verified 700 historical entries and 35 supplemental files. The public canary passed historical and new downloads, HEAD, private range and no-store, anonymous denial, pending and old-Windows upload promotion, and revocation of an issued ticket. Initial intermittent PostgreSQL connection timeouts caused HTTP 500s and were observed independently of S3. Current Play Store binary and native end-user GUI coverage remain unverified.

A separate request for a 64 MiB multipart upload on the live synthetic account returned HTTP 413 upload_limit as required by that account’s plan. The private Frankfurt test bucket passed the multipart upload/resume/completion suite. Production multipart completion with a suitably entitled account was not verified. No customer plan or entitlement was changed to run a test.
