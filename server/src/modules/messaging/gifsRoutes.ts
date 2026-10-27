import type { FastifyInstance } from "fastify";
import { z } from "zod/v4";
import { type AppContext } from "../../app/context.js";
import type { GifConfig } from "../../app/config.js";
import { me, requireAuth } from "../auth/index.js";
import { parse } from "../../shared/validation/index.js";
import { ApiError, badRequest } from "../../shared/errors.js";

/**
 * GIF search through this server (API 0.45.0, docs/GIFS.md): the apps never call the GIF provider themselves, so the
 * provider sees this server, not the person, and pages keep their Content-Security-Policy (images from this origin
 * only). Searches are POSTed (search words never appear in request logs) and aren't stored. Media is fetched only from
 * the provider's own media hosts, as GIF, WebP or MP4, up to a size limit. Off until GIF_PROVIDER and GIF_API_KEY are set.
 */

const SearchBody = z.object({ q: z.string().trim().min(1).max(80), pos: z.string().max(200).optional() });
const TrendingBody = z.object({ pos: z.string().max(200).optional() });
const MediaQuery = z.object({ src: z.string().max(2048) });

const PAGE = 24;
const MEDIA_MAX_BYTES = 12 * 1024 * 1024;
const FETCH_MS = 15_000;
const MEDIA_TYPES = new Set(["image/gif", "image/webp", "video/mp4"]);

/** The hosts each provider serves its media from: nothing else is fetched. */
export function allowedMediaHost(provider: GifConfig["provider"], host: string): boolean {
  const h = host.toLowerCase();
  if (provider === "tenor") return h === "media.tenor.com" || /^media\d?\.tenor\.com$/.test(h) || h === "c.tenor.com";
  return /^media\d?\.giphy\.com$/.test(h) || h === "i.giphy.com";
}

export interface GifResult {
  id: string;
  title: string;
  preview: { url: string; width: number; height: number };
  gif: { url: string; width: number; height: number };
}

const zTenor = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      content_description: z.string().default(""),
      media_formats: z.record(z.string(), z.object({ url: z.string(), dims: z.array(z.number()).length(2) })),
    }),
  ),
  next: z.string().default(""),
});
const zGiphyImage = z.object({ url: z.string(), width: z.coerce.number(), height: z.coerce.number() });
const zGiphy = z.object({
  data: z.array(z.object({ id: z.string(), title: z.string().default(""), images: z.object({ fixed_width: zGiphyImage, original: zGiphyImage }) })),
  pagination: z.object({ offset: z.number(), count: z.number(), total_count: z.number().optional() }),
});

async function providerJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS), headers: { accept: "application/json" } });
  } catch {
    throw new ApiError(502, "gif_provider_unavailable", "The GIF service didn't answer. Try again.");
  }
  if (res.status === 429) throw new ApiError(429, "rate_limited", "Too many GIF searches right now. Try again in a moment.");
  if (!res.ok) throw new ApiError(502, "gif_provider_unavailable", "The GIF service refused the request.");
  return res.json();
}

/** One page of results (a search, or what's popular), in one shape for either provider; [next] continues it. */
export async function gifPage(cfg: GifConfig, q: string | null, pos: string | undefined): Promise<{ results: GifResult[]; next: string | null }> {
  if (cfg.provider === "tenor") {
    const params = new URLSearchParams({ key: cfg.apiKey, client_key: "meldiq", limit: String(PAGE), media_filter: "tinygif,gif", contentfilter: cfg.rating });
    if (q) params.set("q", q);
    if (pos) params.set("pos", pos);
    const r = zTenor.parse(await providerJson(`${cfg.apiBase}/${q ? "search" : "featured"}?${params}`));
    return {
      results: r.results.flatMap((g) => {
        const preview = g.media_formats.tinygif ?? g.media_formats.gif;
        const full = g.media_formats.gif ?? preview;
        if (!preview || !full) return [];
        return [{ id: g.id, title: g.content_description.slice(0, 200), preview: { url: preview.url, width: preview.dims[0], height: preview.dims[1] }, gif: { url: full.url, width: full.dims[0], height: full.dims[1] } }];
      }),
      next: r.next || null,
    };
  }
  const offset = Number(pos ?? 0) || 0;
  const params = new URLSearchParams({ api_key: cfg.apiKey, limit: String(PAGE), offset: String(offset), rating: cfg.rating });
  if (q) params.set("q", q);
  const r = zGiphy.parse(await providerJson(`${cfg.apiBase}/gifs/${q ? "search" : "trending"}?${params}`));
  const next = offset + r.pagination.count;
  return {
    results: r.data.map((g) => ({
      id: g.id,
      title: g.title.slice(0, 200),
      preview: { url: g.images.fixed_width.url, width: g.images.fixed_width.width, height: g.images.fixed_width.height },
      gif: { url: g.images.original.url, width: g.images.original.width, height: g.images.original.height },
    })),
    next: r.pagination.count > 0 && (r.pagination.total_count === undefined || next < r.pagination.total_count) ? String(next) : null,
  };
}

export default async function gifRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx), config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };
  const cfg = () => {
    const c = ctx.config.gifs;
    if (!c) throw new ApiError(503, "gifs_not_configured", "GIFs aren't set up on this server yet.");
    return c;
  };

  app.get("/v1/gifs/status", auth, async () => {
    const c = ctx.config.gifs;
    return { configured: !!c, provider: c?.provider ?? null, attribution: c ? (c.provider === "tenor" ? "Search Tenor" : "Powered by GIPHY") : null };
  });

  app.post("/v1/gifs/search", auth, async (req) => {
    me(req);
    const body = parse(SearchBody, req.body);
    return gifPage(cfg(), body.q, body.pos);
  });

  app.post("/v1/gifs/trending", auth, async (req) => {
    me(req);
    const body = parse(TrendingBody, req.body ?? {});
    return gifPage(cfg(), null, body.pos);
  });

  /** A GIF's file from the provider's media host (never any other address), with its own type, for the page to show. */
  app.get("/v1/gifs/media", auth, async (req, reply) => {
    me(req);
    const c = cfg();
    const { src } = parse(MediaQuery, req.query);
    let u: URL;
    try {
      u = new URL(src);
    } catch {
      throw badRequest("Not a GIF address");
    }
    if (u.protocol !== "https:" || !allowedMediaHost(c.provider, u.hostname) || u.username || u.password || (u.port && u.port !== "443")) throw badRequest("Not a GIF address");
    let res: Response;
    try {
      res = await fetch(u, { signal: AbortSignal.timeout(FETCH_MS), redirect: "error" });
    } catch {
      throw new ApiError(502, "gif_provider_unavailable", "The GIF couldn't be loaded.");
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!res.ok || !MEDIA_TYPES.has(type)) throw new ApiError(502, "gif_provider_unavailable", "The GIF couldn't be loaded.");
    if (Number(res.headers.get("content-length") ?? 0) > MEDIA_MAX_BYTES) throw new ApiError(413, "too_large", "That GIF is too large.");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MEDIA_MAX_BYTES) throw new ApiError(413, "too_large", "That GIF is too large.");
    return reply.header("content-type", type).header("x-content-type-options", "nosniff").header("cache-control", "private, max-age=86400").send(buf);
  });
}
