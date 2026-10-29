# Account email (verification, password reset, notices)

The server sends three kinds of account email (`server/src/accounts/mailer.ts`, `mailTexts`): the sign-up verification
code, the password-reset code, and the "someone tried to register with your email" notice. Plain text, no links, nothing
anyone typed. Codes are short-lived (15 minutes), single-use and attempt-limited; resend and recovery answers are
generic; sending is rate-limited per network (`ACCOUNT_EMAILS_PER_NETWORK_PER_HOUR`). No transport ever logs a body.

## Transports (`MAIL_TRANSPORT`)

| Value | Use | Settings |
|---|---|---|
| `none` | default: sign-up and reset answer 503 | — |
| `file` | development only (refused in production): one `.eml` file per message, mode 0600 | `MAIL_FILE_DIR` |
| `ses` | Amazon SES (production since 2026-10-18, sandbox) | `MAIL_FROM`, `SES_REGION`, optional `SES_ACCESS_KEY_ID`/`SES_SECRET_ACCESS_KEY` |
| `smtp` | any SMTP provider; **Hostinger Mail** for development and early testing (2026-10-19) | `MAIL_FROM` (or `MAIL_FROM_NAME` + `MAIL_FROM_ADDRESS`), `SMTP_HOST`, `SMTP_PORT` (465), `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` |

SMTP is always encrypted: TLS from the first byte on port 465, a required STARTTLS upgrade on any other port, TLS 1.2 or
newer with the certificate checked, 15-second timeouts, nodemailer's logging off (`smtpTransport`). Swapping providers
(Hostinger → SES, Resend, Postmark…) is a change of environment variables only; authentication code never calls a
provider directly. Tests: `server/test/mail_smtp.test.ts` (configuration guards, TLS settings, sending, error pass-through).

## Email design (`server/src/accounts/mailTemplate.ts`)

Every account email has an HTML version and a plain-text twin, built from the same parts: the Meldiq logo and name,
a card with a heading, short paragraphs and, for codes, the code in large monospaced type with its expiry, then a
"never ask you for a code" line and an automated-message footer. Graphite light colours, Graphite dark where the client
honours `prefers-color-scheme`.

- **Logo:** a 128×128 PNG embedded in the message (`cid:logo@meldiq.app`, rendered from `brand/meldling.png`, the app's Meldling face, by
  `server/scripts/render-mail-logo.py` into `mailLogo.ts`). Nothing is loaded from the web, so it shows without "load
  images" and can't track the reader.
- **No links**, nothing a user typed; every value is HTML-escaped (`test/mail_template.test.ts`).
- **Copying the code:** email can't run scripts, so there is no real copy button. The code is one tap to select
  (`user-select: all`), and Gmail adds its own Copy button when it recognises a verification code.
- **Logo next to the sender in the inbox** (the avatar) is a different thing: BIMI. It needs DMARC at `quarantine` or
  `reject` and, for Gmail and Apple Mail, a paid Verified Mark Certificate (trademark-backed). Not set up.
- SES sends the designed version as a raw MIME message (its simple form has no inline images); SMTP sends it as is.

## Hostinger Mail for `no-reply@meldiq.app` — live in production since 2026-10-19

The owner chose the sender **`Meldiq <no-reply@meldiq.app>`** (the brief's `meldeq.app` isn't a domain the account owns;
`meldiq.app` is, bought 2026-10-19).

| Step | Status |
|---|---|
| Domain `meldiq.app` in the Hostinger account, Hostinger DNS | done (bought 2026-10-19; `web.meldiq.app` already points at the VPS) |
| Email plan | **Starter Business Email** (1 mailbox seat, 1,000 outgoing messages per day), attached to `meldiq.app` by the owner in hPanel; status active |
| Mailbox `no-reply@meldiq.app` | created by the owner in hPanel (2026-10-19 14:04 UTC); IMAP/POP3/SMTP enabled. The password is only in the server `.env` (`SMTP_PASS`) |
| SMTP settings | `smtp.hostinger.com`, port 465, TLS from the start (`SMTP_SECURE=true`); sign-in checked |
| SPF / DKIM / DMARC | created by hPanel, checked with `dns_records_list`: MX `mx1`/`mx2.hostinger.com`, SPF `v=spf1 include:_spf.mail.hostinger.com ~all`, DKIM CNAMEs `hostingermail-a/b/c._domainkey`, DMARC `v=DMARC1; p=none` (no reporting address yet; tighten to `quarantine` later, owner's go-ahead) |
| Delivery test | from the Mac through `SmtpMailer`: DKIM pass (`hostingermail-a`), SPF pass, DMARC pass. From the production container to the same mailbox: delivered, but Hostinger's internal route (`fr-int-smtpout30`) carried no DKIM signature, so a check from an outside inbox is still owed |
| Production | **switched 2026-10-19 14:10 UTC**: `MAIL_TRANSPORT=smtp`, `MAIL_FROM="Meldiq <no-reply@meldiq.app>"` (was `Orbit <no-reply@griipbuddy.cloud>` over SES), API service restarted alone, healthy, 0.7.0. `.env` backup `backups/pre-smtp-20261019T141003Z/env.backup`; the SES variables stay in place, unused. Rollback: restore that file, then `docker compose -p griip-internal-messaging -f compose.yaml up -d --no-deps --no-build api` |

Hostinger's limits (1,000 messages/day, 100 recipients per message) are fine for early testing; a transactional
provider (SES out of the sandbox, Resend) is the path for public launch.
