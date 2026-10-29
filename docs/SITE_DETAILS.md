# Site and legal details (API 0.60.0, owner's request 2026-10-29)

Who runs Meldiq and its policies are edited in the Platform Admin Console instead of being written into the website's
code: Settings › **Legal & business details** (`GET /admin/v1/site` with `settings.view`; `PUT /admin/v1/site` with
`settings.edit`: super admins, a fresh passkey check and a written reason; audited as `site.update`, field by field
with before and after).

The website (meldiq.app) and the apps read them from `GET /v2/site/details` (public, `cache-control: public,
max-age=60`, served during maintenance too). A field that is `null` hasn't been decided: the website shows it as
"to be confirmed" and never invents a value.

| Group | Fields |
|---|---|
| `operator` | `legalName` (GRIIPBUDDY LLC), `address`, `jurisdiction` (e.g. "Delaware, USA"), `registration`, `governingLaw` |
| `contacts` | `supportEmail`, `privacyEmail`, `dpo` |
| `policies` | `minimumAge` (13–21), `refundWindowDays` (14), `refundRules` (plain text, blank lines between paragraphs), `failedPaymentGraceDays` (0–30), `legalBases`, `billingRecordRetention`, `transferSafeguards` |
| | `legalUpdatedOn` (YYYY-MM-DD, shown on every legal page) |

- Stored in `platform_settings` under `site.details` (SQLite, beside the platform controls); code in
  `server/src/app/siteDetails.ts` and `server/src/modules/platformAdmin/siteAdmin.ts`; tests in
  `server/test/site_details.test.ts`.
- **Grace period:** `admin.js billing-mojo-plans` publishes Mojo Go and Plus with the console's
  `failedPaymentGraceDays` (0 until set). A published plan version never changes: to change the grace of plans already
  on sale, publish a new version in the console's Plan catalog.
- Trials, invite days and Mojo's limits are set elsewhere in the console (docs/BILLING.md › Running trials from the
  console, docs/MOJO.md › Running Mojo from the console).
