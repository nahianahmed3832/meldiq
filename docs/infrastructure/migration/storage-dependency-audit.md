# Storage dependency audit

Hostinger still runs the API. The accepted database is Supabase PostgreSQL in eu-central-1. Production mail uses Hostinger SMTP. The Singapore SES configuration belongs to a different domain and is not the active Meldiq mail path. The archived Singapore EC2 instance is stopped. Its DLM snapshot schedule and the Singapore status schedule are disabled.

## Migration record

The Fastify adapter already provides upload authorization, reservation, single PUT, multipart create/sign/list/complete/abort, checksum verification, retry handling, ranged downloads and versioned deletion. Configuration is centralized in server/src/app/config.ts and server/src/infrastructure/storage. The active environment uses STORAGE_BACKEND, S3_BUCKET, S3_REGION, S3_PREFIX and STORAGE_READ_FALLBACK. Preserve these deployed names and the existing API shapes. Do not configure a second image or WebP conversion in the Worker.

Object types observed in the source version inventory include attachments, profile photos, legacy AI files and profile-test objects. Preserve every prefix, including historical objects no longer represented by a current attachment record. Database file IDs, conversation ownership, publication state and quotas belong to the API. Documents, images, GIFs, voice and video use the attachment path. Profile photos and collectible assets have dedicated API routes. The inspected source also contains retention, quota, file cleanup, preview, sticker/emoji and history code. Nothing in this migration treats a storage key as proof of a right to download.

The web fallback at /media/attachments follows only operator-allowed upstream origins and strips the user's authorization and cookie headers. The window renderer enforces a separate packaged CSP. Both previously allowed only Singapore for direct S3 connections. Android's AttachmentUploader consumes backend-supplied signed requests. Admin analytics uses the word “bucket” for data groupings unrelated to S3.

STORAGE_READ_FALLBACK=local was actually enabled. Of 525 active attachment references, 490 matched the sizes of current Singapore objects and 35 used disk. All 35 files were found. No local profile-photo or AI-file fallback files were present in the inspected directories. One upload-session document existed at MongoDB audit time. Its presence does not establish that a current multipart session can safely change regions. At cutover check both the authoritative application session table and S3 multipart lists.

The active backend is revision 458aebfa on PostgreSQL. New clients use Frankfurt direct upload grants; the exception for old Windows and captured upload sessions promotes and verifies the bytes before publication. Signed private downloads redeem through the global edge. Browser connect origins are deployment-controlled.
