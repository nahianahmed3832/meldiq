# Public and product consistency

The deployed API retains all completed files independently of message timers, including unpublished files, with uploader-only access until publication. Its production runtime cannot access the Singapore media bucket. The storefront and desktop repository snapshot carry the same privacy disclosure.

## Migration record

| Subject | Authoritative owning path | Result |
|---|---|---|
| Per-file limits and ownership | API files routes, quotas, plan catalog and Spark overrides | Existing upload validation and pricing data preserved. The storefront advertises the live decimal 1 GB cap for Plus. |
| Media privacy | Backend files route, v2 message envelope and attachment encryption | Public file-sharing descriptions now identify server-readable current attachment keys. No global replacement of legacy encrypted-envelope behavior. |
| Storage and availability | Active backend config, origin verification and the independent status API | Frankfurt is primary. A public authenticated canary independently exercised customer upload and download paths. |
| Public links | Existing storefront download constants, Play listing, signed Windows feed and web.meldiq.app | Verified at the storefront release checkpoint. The verified signed 0.2.1 release is live. |
| Admin operations | Admin API permissions and runtime configuration | Console consumes API contracts. The operational command reports configured backend/region. The active writer now uses Frankfurt. |
| Clients and branding | Existing client code, CSS, status Site and marketing assets | Only storage-dependent behavior and inaccurate text changed. Pricing logic, gifts, entitlements, free profile customization and product design were not changed. |

Supabase/PostgreSQL is the confirmed authoritative database. The public privacy page and packaged storefront source reflect Frankfurt primary, Singapore recovery/compatibility and global Cloudflare delivery.

The final live catalog measured USD 4.99 and a decimal 1 GB effective cap for Meldiq Plus. Corrected the outdated storefront preview and operator documentation. On-sale data remains null, so this work did not open checkout. The separate Bots+ price was preserved. The retired Android GitHub beta has a different application ID from the current Play listing. Windows release and storefront now agree on 0.2.1.
