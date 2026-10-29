# Meldiq for Android 0.7.0-beta (versionCode 30), 2026-10-29

Branch `android-floating-redesign`. For production (`https://msg.meldiq.app`, API 0.61.0 and later). Built unsigned;
the owner signs it (Android Studio › Build › Generate Signed App Bundle / APK, upload key in `signed_file/`) and
publishes it (docs/RELEASE_BUILDS.md).

## What's in it (since the last published build)

- **Messages stored by the server** (API 0.57.0): the app reads and sends `/v2/messages`; older apps can no longer send
  until they update, so this release is the one people need.
- **The floating redesign**: the brandbar, the Spark tab and community Spark goals, the redesigned profile card, call
  stage and Mojo pages, Meldling art across the app.
- **Activity status** (API 0.56.0): share what you're playing, opt in.
- **The green Meldling logo** again: launcher, themed and notification icons, launch screen.
- **Profile decorations** (API 0.61.0): 68 of Meldiq's own, community ones with their makers' names, making and sending
  in your own, the Artist badge and an artist's decorations on their profile.

## Play Console "What's new" (≤ 500 characters)

English:

> Profile decorations: pick from 68 Meldiq frames and community-made ones, or make your own and send it in. Messages
> now sync through Meldiq's servers, so your chats follow you to every device. A fresh floating design, the Spark tab,
> activity status ("Playing …"), and the green Meldling icon is back.

Bangla:

> প্রোফাইল সাজ: Meldiq-এর ৬৮টি ফ্রেম ও কমিউনিটির বানানো সাজ থেকে বেছে নিন, অথবা নিজে বানিয়ে পাঠান। মেসেজ এখন Meldiq-এর
> সার্ভারে থাকে, তাই আপনার চ্যাট সব ডিভাইসে পাবেন। নতুন ফ্লোটিং ডিজাইন, Spark ট্যাব, অ্যাক্টিভিটি স্ট্যাটাস, আর ফিরে এসেছে সবুজ Meldling আইকন।

Chinese:

> 头像装饰：从 68 个 Meldiq 装饰和社区作品中挑选，或自己制作并提交。消息现在由 Meldiq 服务器同步，所有设备都能看到你的聊天。
> 全新悬浮设计、Spark 标签、活动状态，绿色 Meldling 图标也回来了。

## Checks before publishing

1. Sign the **release** bundle (not the debug APK) with the upload key.
2. Install it on a real phone; sign in; open a chat, send a message, open Settings › Profile style › Avatar decoration,
   wear one, and look at your profile card (docs/RELEASE_BUILDS.md step 8).
3. Upload to internal testing first, then promote.
