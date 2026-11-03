# Frankfurt production cutover

**Final state on 3 November 2026.** Frankfurt is the sole live media region. Hostinger runs the API and Supabase remains the database. With release b7bffce7 live at 08:37:06 UTC, all new uploads, including older Windows clients, go to Frankfurt. The production principal is denied access to Singapore media. The Singapore bucket, its versions and five stopped-server snapshots remain for recovery. Both the Singapore status and snapshot schedules are disabled.

The final PostgreSQL inspection counted 533 completed attachment rows and zero finite expiry values. Eight pending-publication rows remained private to their uploaders. The retention job skips completed-file expiry under this deployment policy. Message timers do not remove stored files. Incomplete multipart transfers remain subject to cleanup. The production compatibility test used the original published desktop payload with matching Electron on macOS. Native Windows 0.2.1 qualification ran separately.

The two earlier backup archives (317,904 encrypted bytes) and a final operator checkpoint are verified in Frankfurt. The status site still displays real observations from the Frankfurt monitoring location; consult it for service-wide health. No whole-database or Hostinger relocation was performed.

## Earlier release windows


Production file storage switched to Frankfurt on 3 November 2026 at 08:08:53 UTC (16:08 Shanghai). The API runs revision `458aebfad5a17155cd80d5630f8060fd40d0b5cb` on the accepted PostgreSQL/Supabase base `f2f7c6c3`. The storage deployment preserved database authority, volumes, credentials and the existing database acceptance receipt.

Under the shared release lock the API upstreams served scheduled maintenance, the old writer stopped and the final inventory matched 618 verified data versions (2,180,958,913 bytes), 82 soft-delete markers and 35 supplemental disk files (66,188,312 bytes). Two in-flight Singapore sessions were captured. The new API started and an authenticated loopback read resolved to the Frankfurt origin with the expected bytes before public traffic reopened. Singapore was retained without deleting data.

The public canary verified historical and newly uploaded files, completion of the pending Singapore upload and the older Windows compatibility path. It checked content ranges, HEAD, private no-store responses and anonymous denial. Logging out of the isolated session invalidated its existing ticket. New clients upload directly to Frankfurt. Older Windows releases can PUT temporarily to Singapore. The API copies and verifies those bytes in Frankfurt before marking the upload complete.

During early public checks some API requests returned 500 when the PostgreSQL pool timed out. An independent check then passed all four media paths and revoked-ticket denial. The service-wide status and the storage result must be reported separately. The current Google Play binary was not tested end to end. The public Windows 0.2.1 installer was signed, published and verified.

The origin serves private data through the Cloudflare Worker at media.meldiq.app. Status remains on the independent customer-owned Cloudflare Worker at status.meldiq.app. The previous Sites D1 is archival. Both AWS monitoring regions remain in service, and the API host, database and global edge are not a Germany-only processing claim.

The protected operator evidence directory contains the fence and activation receipts, encrypted recovery backup reference, exact release verification, public probe receipts and version-specific reverse plan. Do not run the forward copier on the now-active destination. A reverse cutover requires fencing and reconciliation of all German writes first.

Singapore version and delete-marker expiration was suspended by a reviewed lifecycle-only stack change. Readback confirmed that the incomplete multipart cleanup remains enabled. The expected storage cost now includes ongoing Singapore history retention.

Production retention inspection found ATTACHMENT_KEEP_FOREVER=true. All 525 published attachment rows had the keep-forever timestamp. Four additional completed uploads were still pending message publication. S3 in Frankfurt has no permanent object-version expiration. This evidence covers published attachments; canceled drafts, incomplete uploads, delivery queues, disappearing messages and separately retained backups are different data classes.

The production database uses a TLS-verified Supabase session pool in eu-central-1. The API host remains a separate Hostinger VPS whose IP geolocates to Kuala Lumpur. The authenticated AWS account reported no existing Frankfurt EC2 or Lightsail instances. API host relocation has not occurred.
