# DNS and TLS record

Cloudflare is authoritative for meldiq.app. Wrangler OAuth succeeded; its zone-record list was denied. The signed-in DNS dashboard showed 19 records during the inspection. The complementary authoritative snapshot included apex, application, admin, RTC, web, status, autodiscovery and mail hosts, MX, SPF, DKIM, DMARC, a BIMI query and status ownership validation. The migration used a Worker custom domain to add media.meldiq.app. It did not replace an existing host or edit mail settings. The optional zone subscription and WAF-policy APIs were not verified by this session.

The status domain's separate Sites CNAME and TXT were being configured concurrently. The Sites provider confirmed active domain and active TLS. Resolution through the VPS's caching resolver initially returned an old negative entry. Direct authoritative and independent resolver checks then produced Cloudflare edge addresses; a hostname-verified TLS request returned the Worker's private no-store denial. The domain, Worker and encrypted origin connection were verified separately.

The normalized before-and-after authoritative answer comparison found two new media A answers and zero removals in the recorded set. The account's DNS-listing API was inaccessible through the Worker OAuth token, so this is not an account-wide assertion about every possible record or concurrent operator action.
