# Frankfurt configuration

CloudFormation created orbit-storage-meldiq-frankfurt in eu-central-1 with termination protection. The template and identity policy are in deploy/storage-migration. Readback verified AES256, enabled versioning, BucketOwnerEnforced, all four public access blocks and IsPublic=false. Anonymous listing returned 403. CORS preserves the existing web/admin GET, HEAD and PUT contract. The one-day incomplete-upload rule is enabled. There is no destination noncurrent-version expiration during migration.

The runtime stack adds prefix-limited put, read and multipart operations for the existing backend identity. Delete and prefix-list operations are limited to the existing server address. The separate Worker health identity can GetObject on exactly one monitoring fixture. It cannot read a user attachment or administer the bucket. Private attachment reads use a short-lived SigV4 URL issued by the backend. No AWS client keys are distributed to desktop, Android or web clients.

S3 request metrics and a Frankfurt 5xx CloudWatch alarm are configured. The alarm has no notification action. The independent status probes also test the public path. The existing multi-region account trail did not show S3 data-event selectors. Bucket access logging, a separate disaster-recovery backup of new writes and notification delivery have not been verified as active controls.

A later reviewed CloudFormation change added a private encrypted access-log bucket and its service-principal delivery policy. The change set reported no replacement of the media bucket or its HTTPS policy. Check get-bucket-logging for the configured destination. Delivery of historical log files is asynchronous.
