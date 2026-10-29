# Meldiq for Android 0.7.1-beta (versionCode 31), 2026-10-29

Branch `android-floating-redesign`. Supersedes 0.7.0-beta (30), which was never published. For production
(`https://msg.meldiq.app`, API 0.64.0 and later; older servers simply show no pins). Built unsigned; the owner signs it
(Android Studio › Build › Generate Signed App Bundle / APK, upload key in `signed_file/`).

## What changed since 0.7.0-beta

The owner's list of 2026-10-29:

- **Spark goal bar** fills by the count shown: "2/5" is 40% (it used to show the share of the step from Level 1).
- **Profile style picks take on the first tap**: a choice shows at once and saves in the background (taps used to be
  dropped while the previous save ran, so it took several).
- **Animated community icons and banners**: a GIF or WebP plays (Android 9+, not with reduced motion), and owners can
  upload one as it is.
- **Profile pins**: a row of pins under the name on profiles, Meldiq's for milestones and the ones communities give;
  tap one to see what it is. They replace the Bug Hunter and Artist chips.
- Discover was already its own screen without the friends list; unchanged.

Everything in 0.7.0-beta (docs/ANDROID_RELEASE_0.7.0.md) is included.

## Play Console "What's new" (≤ 500 characters)

English:

> Profile pins: earn Meldiq pins for milestones and wear the pins your communities give you. Community icons and
> banners can be animated. Profile style choices now apply on the first tap, and the Spark goal bar shows real progress.
> Plus everything from 0.7.0: profile decorations, messages on every device, the floating design and the green Meldling
> icon.

Bangla:

> প্রোফাইল পিন: মাইলফলক ছুঁয়ে Meldiq পিন পান, আর কমিউনিটির দেওয়া পিন প্রোফাইলে দেখান। কমিউনিটির আইকন ও ব্যানার এখন
> অ্যানিমেটেড হতে পারে। প্রোফাইল স্টাইল এখন এক ট্যাপেই বদলায়, আর Spark লক্ষ্য বার সঠিক অগ্রগতি দেখায়।

Chinese:

> 个人徽章：达成里程碑获得 Meldiq 徽章，并展示社区颁发的徽章。社区图标和横幅支持动图。个人资料样式一次点击即可生效，
> Spark 目标进度条显示真实进度。

## Checks before publishing

1. Sign the **release** bundle with the upload key.
2. On a real phone: open a profile with pins and tap one; in Settings › Profile style tap several choices quickly
   (each should tick at once); open a community with an animated icon or banner; check the Spark goal bar.
3. Upload to internal testing first, then promote.
