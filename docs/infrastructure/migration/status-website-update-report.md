# Independent production status

The owner requested Frankfurt-only operations. status.meldiq.app now expects Frankfurt as its sole external monitoring location. The Singapore schedule is disabled and its historical samples remain available. Worker release 83b602b5-3849-4d4d-af1e-6b839ed17674 applied the region change. Scheduled synthetic observations determine current public status.

## Migration record

The canonical status.meldiq.app and its verification alias status-check.meldiq.app serve the customer-owned Cloudflare Worker and independent D1. The status operator imported the previous Sites data and took ownership of the canonical hostname. The old Sites D1 is archival. Both AWS monitoring regions remain enabled. Storage administration and maintenance posting targeted the live D1.

The Frankfurt origin probe requests a signed, uncached range and validates its exact bytes. The media edge probe checks a dedicated public fixture. Customer-upload and download monitoring also includes API readiness, an authorized private range with an expected hash, creation and cancellation of an isolated presigned upload session, and synthetic object I/O. Regional monitoring configurations switched to Frankfurt storage and private edge delivery after the API opened. The database probe now checks PostgreSQL, Supabase mode and Redis, matching the accepted production database.

The owner deployed an independent presentation of customer-facing service rows. Public aggregation, sample freshness and maintenance can differ from the outcome of a single storage canary. No existing incident history was rewritten to make storage look healthy. The API pools briefly timed out after the switch while the Frankfurt origin was reachable. A real maintenance window was posted for 08:08–08:16 UTC.

The public JSON endpoint is /api/public/status. Operator-only probe details, signed URLs, private identities and AWS keys do not belong in public incident descriptions.

The status owner confirmed native release df7dc4f4-f12c-4b9a-8011-005d1742536e, seven customer-facing rows, 18 underlying components and 24 probes. Use the existing customer-owned deployment configuration for future status updates.

The first live upload-session measurement uncovered a monitor bug. It supplied a JSON Content-Type with an empty DELETE body. Both regional Lambda archives were redeployed after adding a valid cancellation body and regression test. A real rerun against the public production API then created and canceled the session successfully. The S3 checks from both regions now use Frankfurt.

Frankfurt upload sessions succeeded at 08:45:50 UTC (5,019 ms) and 09:00:50 UTC (3,747 ms). Both were genuine measured successes. The status reducer counted only consecutive checks on the same side of the four-second latency threshold and incorrectly kept the outage open. Native Worker release d771ba64-cfb4-4a1e-aa26-7bb295927a25 separates availability recovery from sustained latency; 43 status tests passed. It uses the stored observations without rewriting samples.
