# GIF search (API 0.45.0)

The apps search and show GIFs **through this server**: the provider (Tenor or GIPHY) never sees the person's browser or
address, and web pages keep loading images from their own origin only (CSP unchanged). Feature: `gif-search`;
`GET /v1/gifs/status` says whether a provider is set up.

## Setting it up (owner)

Add to the API's `.env`, then recreate the API container:

- `GIF_PROVIDER=tenor` with a Tenor API key from Google Cloud (Tenor API v2), or `GIF_PROVIDER=giphy` with a GIPHY
  API key (developers.giphy.com).
- `GIF_API_KEY=<key>` (never commit it).
- Optional `GIF_RATING`: Tenor content filter (default `medium`) or GIPHY rating (default `pg-13`).

Until both are set, the GIF tab says "GIFs aren't set up on this server yet" and offers nothing that would fail.
Follow the provider's attribution rule: the picker shows the provider's attribution line.

## How it works

- `POST /v1/gifs/search {q}` and `POST /v1/gifs/trending`: the words go in the body, so they never appear in request
  logs, and nothing is stored. Rate limited (60 a minute per person).
- `GET /v1/gifs/media?src=…`: fetches a GIF file only from the provider's media hosts (`media*.tenor.com`,
  `media*.giphy.com`, `i.giphy.com`), https only, no redirects, GIF/WebP/MP4 only, ≤ 12 MB.
- A GIF message carries `gif {provider, id, url, width, height, title}` inside the end-to-end encrypted message; its
  text is the GIF's address, so apps that don't show GIFs show the link. Apps show a GIF only when its address is on its
  provider's media hosts.
