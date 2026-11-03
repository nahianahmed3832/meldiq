# Security verification

The scoped runtime IAM policy now denies access to the Singapore media bucket. The versioned first-party compatibility route accepts only signed PUT requests for exact attachment paths, checks upstream TLS, streams bytes to a fixed Frankfurt origin and disables request logging. Signing credentials and user session headers are not forwarded.

## Migration record

The source and destination are private and encrypted. The Frankfurt origin denies insecure transport. The runtime IAM policy is confined to the application prefix and server-originated deletion/listing. A separate IAM identity may only read the exact public fixture from the private bucket. The Worker holds no AWS credential capable of reading a customer object. Worker secrets are encrypted bindings. API secrets are not client settings. Private manifest files and keys are excluded from source control.

Authorized downloads are scoped to one file, expire quickly, and require a live session and conversation membership on redemption. The API checks pending publication and charges byte quotas. The Worker validates paths, origin and signed redirects, uses no-store on private subrequests and responses, and forwards no client bearer or cookies to S3. Obsolete/invalid/tampered grants, logged-out sessions and a different conversation member were exercised in tests. Live anonymous reads were denied without origin details. The single explicitly public synthetic fixture is the only shared-cache path.

Unresolved before primary activation: verify real authorized, unauthorized, cross-organization, revoked and historical production media via the released clients; verify WAF/rate-limit behavior on the new host; retain redacted access logs; verify actual billing alerts and recovery of post-cutover writes. The independent origin health check does not exercise a customer session. Attachment bytes are encrypted before upload, but the current v2 relay can read attachment keys. Token-bearing URLs are capabilities and must remain out of logs. No account-wide or EU-only security guarantee is inferred.

The older-desktop and pre-cutover-session compatibility path does not grant storage rights to anonymous callers. It keeps the normal direct upload permission and quota checks, validates the full SHA-256 of a create-only cross-region copy and only then publishes the database record. New API deletion/abandon behavior only touches source uploads assigned to that compatibility path. Do not describe this transitional configuration as Frankfurt-only residency.

The public production test returned 404 for an issued ticket immediately after its isolated legacy session signed out. Successful private reads checked HEAD and ranged bytes as well as no-store. No production signing material or customer records were included in this report.
