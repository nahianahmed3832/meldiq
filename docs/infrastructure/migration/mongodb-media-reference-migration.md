# Database media references

The active container reported DATABASE_MODE=atlas before the independent database maintenance began. An authenticated read-only scan examined 11,291 documents in 51 collections selected by media, attachment, profile, conversation, relay and message names. It walked nested string values and recognized the exact source bucket's virtual-host and path-style URLs, including signed query strings. There were zero matches. Reviewed collections included attachments (525), attachment_uploads (1), submitted_messages (2,921), message_events (3,500), ai_files, abandoned_uploads, profile collectible data and inbox messages.

No database records were rewritten. Existing IDs resolve through the API's object-key convention. All active attachment references were also compared against storage, including the 35 legacy disk records. No user payloads or messages were exported in the aggregate scan. Encrypted fields and unselected collections are not evidence of a database-wide absence of arbitrary links. If a future scan finds a reference, back up only the affected records, use an allowlisted collection/field migration and keep IDs and ownership unchanged.

A separate production database cutover began while storage was being staged. Its maintenance lock is independent of this migration. Rediscover the active authority and check the new database's file and pending-upload tables before changing storage. The Atlas scan alone cannot verify the succeeding authority.

The accepted production PostgreSQL release became authoritative before storage activation. A TLS-verified, read-only repeatable-read scan inspected 52 media-related tables and 11,403 rows on that release. No row contained an absolute Singapore S3 URL. Neither audit rewrote user records or attachment IDs.
