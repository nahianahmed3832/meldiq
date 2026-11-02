# Optimized Android media defaults

Each photo/video send starts optimized (Standard photo compression and 720p video compression). The preview presents one unchecked **Original file** checkbox, which preserves both photos and videos unchanged when selected. Legacy saved global quality choices do not override the next batch. Settings explains the new per-send choice instead of offering additional quality tiers. Documents and unsupported/animated media retain the existing safe handling.

English, Bangla and Chinese copy are included. The existing native compression pipeline is retained. Compilation, debug APK assembly and all 40 focused attachment, picker-text and media-gallery tests pass. Evidence: optimized-default-evidence/. No signed Play Store publication or physical-device certification was performed.
