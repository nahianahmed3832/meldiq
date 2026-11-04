Meldiq universal icons — Android pilot

Canonical source: Meldiq Web `shared/icons/catalogue.json`, version 1.0.0, with 33 Lucide 1.59.0 glyphs. Regenerate through its `scripts/icons/generate.py --android /path/to/android`; use the same command with `--check` to verify parity. Local `mi_*.xml` resources and `ui/icons/MeldiqIcon.kt` are generated. `ui/icons/Icon.kt` is the Compose adapter. The complete upstream ISC/Feather MIT notices ship in `assets/icon-licenses.txt`. No icon library or runtime network dependency was added.

Four bottom navigation destinations now use semantic glyphs. Existing routes, badges, parent TalkBack labels, selected state and minimum 52dp targets remain. Other screens retain Material icons until gradual migration.

Checks: debug Kotlin compilation and resource processing passed. The Robolectric native graphics test renders all 33 bundled vectors into bitmaps and rejects empty/solid output. Tests use the consolidated workspace including pre-existing product changes. Only task-specific files and the icon navigation patch are committed. This is not a clean-checkout release verification. Production signing is manual; no Play upload or physical Android test is claimed.

Keep existing unrelated changes. No backend/database deployment is part of this pilot.
