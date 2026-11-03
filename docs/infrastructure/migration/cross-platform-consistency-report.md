# Public and product consistency

| Subject | Authoritative owning path | Result |
|---|---|---|
| Per-file limits and ownership | API files routes, quotas, plan catalog and Spark overrides | Existing upload validation and pricing data preserved. Storefront advertises 1,024 MB for Plus. Current code uses decimal bytes. |
| Media privacy | Backend files route, v2 message envelope and attachment encryption | Public file-sharing descriptions now identify server-readable current attachment keys. No global replacement of legacy encrypted-envelope behavior. |
| Storage and availability | Active backend config, origin verification and the independent status API | Distinguish the primary store from a staged verified copy and distinguish edge health from private delivery. No fabricated public uptime. |
| Public links | Existing storefront download constants, Play listing, signed Windows feed and web.meldiq.app | Verified at the storefront release checkpoint. Preserve the signed/immutable Windows download path until an independently qualified update is promoted. |
| Admin operations | Admin API permissions and runtime configuration | Console consumes API contracts. The operational command reports configured backend/region. Do not label Frankfurt primary until activation. |
| Clients and branding | Existing client code, CSS, status Site and marketing assets | Only storage-dependent behavior and inaccurate text changed. Pricing logic, gifts, entitlements, free profile customization and product design were not changed. |

A separate database migration reportedly changes the active database authority. Recheck the public processor description after the database operator confirms cutover and retention; a Frankfurt copy alone does not establish a data-residency or legal claim. The packaged Windows storefront snapshot should track the live storefront for the next release.
