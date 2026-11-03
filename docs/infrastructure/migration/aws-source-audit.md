# Singapore source audit

The live API's S3 bucket and prefix matched the authenticated orbit-admin inventory in ap-southeast-1. The production media stack is orbit-storage-prod. Backups, test buckets and status deployment buckets were excluded. Keep private bucket names and the full key manifest out of the public site.

| Initial measurement | Result |
|---|---:|
| Current object versions | 538 |
| Current object bytes | 2,151,436,474 |
| All object versions | 615 |
| Bytes across all versions | 2,180,950,688 |
| Delete markers | 82 |
| Maximum version size | 414,934,013 |
| Open S3 multipart uploads at audit | 0 |

Versioning is enabled. The bucket uses AES256 SSE-S3, bucket-owner-enforced ownership, all four public access blocks, a nonpublic HTTPS-only bucket policy and STANDARD storage. No KMS dependency appeared in copied versions. 614 listed versions carried SHA-256 checksums and one carried CRC64NVME. No source replication configuration, server access logging or request metrics configuration was returned. The existing lifecycle aborts incomplete uploads after one day and expires noncurrent versions after 30 days. The migration did not modify that lifecycle. Source CORS permits GET, HEAD and PUT from the web and admin origins and exposes ETag, checksum, version and range headers.

The migration later added a 33-byte, create-only monitoring fixture. It did not remove or replace a source object. The initial copy used version-qualified server-side copy and replayed each soft delete marker in the service's original order, including versions and markers with identical timestamps.
