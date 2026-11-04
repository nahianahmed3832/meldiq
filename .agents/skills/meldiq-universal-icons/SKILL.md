---
name: meldiq-universal-icons
description: Add, replace, or review interface icons in Meldiq web, desktop, responsive mobile, or Android using the shared semantic catalogue and generated platform assets.
---

Use the canonical Meldiq Web repository's `shared/icons/catalogue.json` and `shared/icons/svg/`. Desktop keeps a generated mirror in `packages/web/shared/icons`; Android consumes generated local vector resources. Mirrors are not independent sources.

Search the catalogue by semantic purpose before selecting an icon. Use `Icon` from `src/ui/icons/Icon.tsx` on web/desktop and the `MeldiqIcon` enum/composable in `com.meldiq.android.ui.icons` on Android. Preserve routing, accessible labels, badges, avatars, product artwork, native tray/menu/window conventions, and touch targets.

For additions, select a matching Lucide outline from the pinned, licensed source; add a semantic identifier, exact upstream/version, SVG, licence notice, sizes, variants, and every platform mapping to the catalogue. Do not substitute emoji or draw arbitrary SVGs. A second family requires a documented missing capability, visual compatibility, and verified licence. Brands require locally bundled official owner SVGs and recorded usage guidelines; do not approximate a brand using Lucide or an unverified icon aggregator.

Keep 24-unit geometry, 2-unit rounded strokes and 16/18/20/24/32 sizes. Express interaction states through parent controls and inherited theme foreground; disabled opacity is 0.38. Keep at least 44px web and 48dp Android interactive targets. Icons beside text are decorative; icon-only controls need accessible names. Never fetch essential icons from an API, CDN or Iconify at runtime.

Run `python3 scripts/icons/generate.py` from the canonical web checkout. Pass `--android /path/to/android` and `--desktop /path/to/desktop` to update consumers. Run again with `--check` and the same paths to detect drift. Run `python3 scripts/icons/test_catalogue.py`, `npm run icons:check`, and `node scripts/icons/browser.mjs` there. See `docs/universal-icons/REPORT.md` for source inventory, adapters, limitations, and gradual migration order.

Keep platform changes together with the catalogue update. Test each affected adapter and representative screen. Report source-only, unsigned, untested physical-device, and unpublished work accurately; an icon task does not grant permission to alter backend or database behavior.
