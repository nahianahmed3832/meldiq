# Android media integration

Adds durable encrypted upload sessions and retry, bounded resumable downloads, optional encrypted previews, Original quality defaults, safe filenames and viewing, bounded active GIF/WebP decoding, and photo/video/filename filters. Account/community limits come from the current server catalog; send preflight applies them again. Upload preflight refreshes entitlements without querying Play offers.

The clean integration contains only this module and preserves other committed native features. The shared Android working tree and its unrelated changes remain untouched. Gallery filters use the committed cached-message window; an uncommitted paginated gallery from another task was excluded.

Validation: 58 focused media/crypto/download/entitlement tests pass. Debug app and instrumentation APK assembly pass. The full JVM run passed 783/787; four existing realtime-contract failures remain (interaction.reply codec support and schema anyOf expectations), with the affected codec/test sources unchanged from the base. See android-evidence/verification.json and logs. Instrumentation was compiled but not rerun on a device for this clean port; earlier viewer/decoder emulator evidence in the Web delivery report belongs to the original working checkout. Physical camera, share/save, background, large-file/load and device decoder coverage remain incomplete.

Web/API were deployed separately as API 0.76.1/schema 8. This native commit is source publication, with local debug artifacts for review; it is not a signed Play Store release.
