# Profile media and style (API 0.45.0)

People can add an **animated avatar**, a **profile banner** and a **profile style** (an avatar frame, a banner effect
and a banner colour). Without them a profile looks exactly as before. Feature: `profile-media`.

## Formats (checked on the server, by the file's bytes)

| What | Accepted | Limits | Stored as |
|---|---|---|---|
| Animated avatar | GIF, WebP (animated or still) | ≤ 4 MB, ≤ 1024 × 1024, ≤ 600 frames | as uploaded |
| Avatar video clip | MP4, WebM (anything ffprobe reads as video) | ≤ 12 MB uploaded, ≤ 6 s | re-encoded by ffmpeg: first 3 s, square 320 × 320, H.264, **no audio**, metadata stripped; plus a JPEG poster frame |
| Banner | JPEG; animated GIF or WebP | JPEG ≤ 1 MB; animated ≤ 6 MB; ≤ 2048 × 1024; ≤ 600 frames | as uploaded |
| Video banner | not supported | | |
| Style | decoration `aurora` `ember` `frost` `neon` `sakura` `pixel`; effect `sparkles` `glow` `stars` `bubbles`; accent `#rrggbb` | fixed lists | `users.profile_style` |

Formats are recognised by signature (`mediaFormats.ts`): GIF and WebP are walked block by block to read their size and
count frames, and anything that doesn't parse cleanly is refused. SVG, HTML or anything else is never accepted, and
files are served with a fixed `content-type` and `nosniff`. Clips are processed with argument arrays the server builds
(never a shell), inside a temporary folder that is removed after, with a time limit. Without ffmpeg on the server the
clip upload answers `media_engine_unavailable` (GIF and WebP still work); the production image includes ffmpeg.

## Who sees it

The animated avatar and banner follow the **photo** privacy setting (the same 404 for "none" and "not allowed"); the
style is shown to everyone who sees the profile. None of it is end-to-end encrypted, like the photo. Lists keep showing
the still photo; the animation plays in the profile card.

## API

`PUT/DELETE /v1/users/me/avatar-media`, `GET /v1/users/:id/avatar-media`, `GET /v1/users/:id/avatar-poster`,
`PUT/DELETE /v1/users/me/profile-banner`, `GET /v1/users/:id/profile-banner`, `PUT /v1/users/me/profile-style`.
Profiles carry `avatarMedia {kind, rev}`, `profileBanner {kind, rev}` and `profileStyle {decoration, effect, accent}`.
Migration 058 adds three nullable columns. Account deletion removes the files; `admin storage-orphans` knows them.

## Apps

Web: Settings › Profile › Profile style (upload with clear limits, live preview, frames and effects drawn in CSS,
Meldiq's own designs), the profile card plays the avatar silently and loops it; with reduced motion it shows the photo
(or the clip's poster) and no effect. Effects stay inside the banner, never over the name, status or avatar.
Android: not yet; the fields are additive.
