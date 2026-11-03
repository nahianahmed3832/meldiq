# Production cutover checkpoint

**Storage staging passed. Application primary activation is pending.**

* AWS: the Frankfurt bucket exists, is private, encrypted and versioned. The 615 original S3 versions, 82 soft delete markers, one new monitoring object and 35 additional disk-backed files were verified. Singapore is retained. See the private manifests for bucket and object details.
* Cloudflare: media.meldiq.app is a deployed Worker custom domain. Fresh authenticated S3 range reads and a public immutable fixture are live. Unauthenticated private requests were denied. The customer grant exchange is staged in API source.
* Database: no reference rewrite. There was a separately controlled production database transition and release lock. Its maintenance response was measured rather than attributed to storage.
* Web and websites: existing web build works with additive live nginx changes. The storefront content update is live. Independent status reported Frankfurt and the media-edge fixture operational during the API outage.
* Windows: public 0.2.0 was incompatible with direct Frankfurt multipart. Native candidate tests passed. The owner authorized signed 0.2.1 stable publication only after the existing qualification procedure.
* Android: local tests passed, released Play binary remains unverified. Admin regression tests passed with one existing skip. Pricing and entitlements were preserved.
* Recovery: keep the private source, local fallback and exact version mapping. A dry reverse comparison found no post-baseline writes at staging. This is not proof that a post-cutover disaster has been recovered.

Before activation obtain the release lock, verify the current writer/image/database mode and build an API image based on that exact compatible release. Check database backup, referenced object sizes, ongoing multipart uploads and currently installed Windows behavior. Final-sync from Singapore under the writer fence, record readback, run authenticated production upload/download/range/denial/revocation tests, verify public status and reopen writes. Record any legitimate maintenance window in the existing status system. Do not bypass a database operator's lock, publish assumed timing or remove Singapore data.
