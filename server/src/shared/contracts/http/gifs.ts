import { z } from "zod/v4";
import { route } from "./route.js";

/** GIF search through the server (API 0.45.0, docs/GIFS.md). */
const gif = (c: Omit<Parameters<typeof route>[0], "tag" | "auth">) => route({ tag: "gifs", auth: true, ...c });

const Media = z.strictObject({ url: z.string(), width: z.number(), height: z.number() });
const GifResult = z.strictObject({ id: z.string(), title: z.string(), preview: Media, gif: Media });
const GifPage = z.strictObject({ results: z.array(GifResult), next: z.string().nullable() });

export const gifRoutes = [
  gif({
    method: "GET",
    url: "/v1/gifs/status",
    summary: "Whether GIF search is set up here, the provider, and the attribution to show.",
    response: z.strictObject({ configured: z.boolean(), provider: z.enum(["tenor", "giphy"]).nullable(), attribution: z.string().nullable() }),
  }),
  gif({
    method: "POST",
    url: "/v1/gifs/search",
    summary: "Search GIFs (the words go in the body, so they're never in a request log; nothing is stored).",
    body: z.object({ q: z.string().min(1).max(80), pos: z.string().max(200).optional() }),
    response: GifPage,
    errors: ["gifs_not_configured", "gif_provider_unavailable", "rate_limited"],
  }),
  gif({
    method: "POST",
    url: "/v1/gifs/trending",
    summary: "Popular GIFs right now.",
    body: z.object({ pos: z.string().max(200).optional() }),
    response: GifPage,
    errors: ["gifs_not_configured", "gif_provider_unavailable", "rate_limited"],
  }),
  gif({
    method: "GET",
    url: "/v1/gifs/media",
    summary: "A GIF's file (image/gif, image/webp or video/mp4), fetched from the provider's own media hosts only.",
    query: z.object({ src: z.string().max(2048) }),
    binary: "response",
    response: z.unknown(),
    errors: ["gifs_not_configured", "gif_provider_unavailable", "too_large", "bad_request"],
  }),
];
