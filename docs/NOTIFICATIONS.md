# Notifications and sounds

## Sounds (2026-10-28)
Since 2026-10-28 the sounds are the ones the owner chose: the ringtone `res/raw/meldiq_ringtone.m4a` (10.6 s, a classic
phone ring, from "soynoviembre-classic-phone-ringtone-439034.mp3", Pixabay) and the message sound
`res/raw/meldiq_message.m4a` (3.4 s, a bell, from Mixkit's "bell notification" 933). Both were converted to AAC (160 kbps,
44.1 kHz, metadata removed); every Android version Meldiq supports plays it. Channels with a sound carry its version
(`_t2`), so phones that already had Meldiq get new channels with the new sounds.

Until then Meldiq had its own message tone and ringtone (0.45 s and 2.6 s), synthesised with ffmpeg from sine tones.

Android fixes a notification channel's sound and vibration when it's created, so each combination of Meldiq's settings
has its own channel (`Channels.Ids`, tested in `UiRulesTest`): `meldiq_msg_s{0|1}v{0|1}`, `meldiq_mention_…`,
`meldiq_call_r{0|1}v{0|1}`, with `_t2` after those that have a sound. When a setting changes (or on first start after updating), Meldiq creates the matching channel
and deletes the old ones of that kind, including the original `messages`, `mentions` and `incoming_call_v2`. A channel the
person had blocked or turned down in Android's settings is recreated at that importance, not reset.

## Settings
Message notifications on/off; group notifications (off: groups and channels stay quiet except mentions of you); message
text in notifications (off: "New message" only, no sender or text, also on the lock screen); message sound; vibration;
call ringtone (off: calls vibrate only); per-chat mute (long-press a chat). Duplicate events never notify twice (a
message is stored once, and each chat has one notification).

## Delivery in the background
Meldiq uses no Google push service (no Firebase credentials in the app, by design). Messages and calls reach a phone over
its own connection to the server:
- while Meldiq is open;
- with "Stay connected in background" on (the default), which needs Android's ongoing "Meldiq is connected" notification;
- or, since 2026-10-17, with "Wake-ups through UnifiedPush" on. A distributor app such as ntfy, set to the push server
  your Meldiq server uses, wakes Meldiq with an empty message, and Meldiq then fetches over its own connection. This needs a
  server that offers it, and production doesn't yet (docs/BACKGROUND_DELIVERY.md). It hasn't been tested on a phone.

With both off, messages and calls arrive only when Meldiq is opened. A force-stopped app gets nothing, whatever the
setting. During a call, Android requires the ongoing-call notification; it stays.
