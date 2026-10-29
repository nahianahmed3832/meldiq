import { z } from "zod/v4";
import { zTime } from "./primitives.js";
import { route } from "./route.js";

/**
 * Channel webhooks (community parity batch C, feature "channel-webhooks", docs/COMMUNITY_PARITY_API.md › Posting
 * tools): a secret address per webhook that anyone holding it can post to, in the JSON Discord's webhooks take, and the
 * in-app "Make a post" builder that posts through one. Managed by holders of `webhooks.manage`.
 */

export const WEBHOOK_LIMITS = {
  perChannel: 10,
  name: 80,
  content: 2000,
  embeds: 10,
  title: 256,
  description: 4096,
  authorName: 256,
  footer: 2048,
  /** All the text of a message's boxes together, as Discord counts it. */
  embedText: 6000,
  buttons: 5,
  buttonLabel: 80,
  emoji: 64,
  url: 2048,
  threadName: 100,
  postsPerMinute: 30,
} as const;

/** An https:// address with a host and no credentials: links and pictures in posts never use anything else. */
export function isHttpsUrl(v: string): boolean {
  if (/\s/.test(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}

const L = WEBHOOK_LIMITS;
const zHttps = z.string().max(L.url).refine(isHttpsUrl, "Use an https:// address");
const zColor = z.union([z.number().int().min(0).max(0xffffff), z.string().regex(/^#?[0-9a-fA-F]{6}$/, "A colour is a number or #RRGGBB")]);

/** A box (Discord's embed). Discord fields Meldiq doesn't show (fields, timestamp, icons) are accepted and dropped. */
export const WebhookEmbedInput = z.looseObject({
  title: z.string().max(L.title).nullish(),
  description: z.string().max(L.description).nullish(),
  url: zHttps.nullish(),
  color: zColor.nullish(),
  author: z.looseObject({ name: z.string().max(L.authorName) }).nullish(),
  image: z.looseObject({ url: zHttps }).nullish(),
  thumbnail: z.looseObject({ url: zHttps }).nullish(),
  footer: z.looseObject({ text: z.string().max(L.footer) }).nullish(),
});

/** A link button in Meldiq's simple form. */
export const LinkButtonInput = z.object({
  label: z.string().trim().max(L.buttonLabel).nullish(),
  emoji: z.string().trim().min(1).max(L.emoji).nullish(),
  url: zHttps,
});

/** Discord's components: action rows (type 1) of buttons (type 2); only link buttons (style 5) can be posted. */
const DiscordButtonInput = z.looseObject({
  type: z.literal(2, "Only buttons can be posted through a webhook"),
  style: z.literal(5, "Only link buttons can be posted through a webhook"),
  label: z.string().trim().max(L.buttonLabel).nullish(),
  emoji: z.looseObject({ name: z.string().max(L.emoji).nullish() }).nullish(),
  url: zHttps,
});
const ActionRowInput = z.looseObject({ type: z.literal(1, "Components are action rows of link buttons"), components: z.array(DiscordButtonInput).max(L.buttons) });

/** Discord's execute-webhook JSON (content, username, avatar_url, embeds, components), plus a simple `buttons` list. */
export const WebhookMessageBody = z.looseObject({
  content: z.string().max(L.content).nullish(),
  username: z.string().trim().min(1).max(L.name).nullish(),
  avatar_url: zHttps.nullish(),
  embeds: z.array(WebhookEmbedInput).max(L.embeds).nullish(),
  components: z.array(ActionRowInput).max(L.buttons).nullish(),
  buttons: z.array(LinkButtonInput).max(L.buttons).nullish(),
  /** A forum channel's new post title (required there, as on Discord). */
  thread_name: z.string().trim().min(1).max(L.threadName).nullish(),
});
export type WebhookMessageBody = z.infer<typeof WebhookMessageBody>;

// ───────────── What a posted message's payload carries (apps show these) ─────────────

export const PayloadEmbed = z.strictObject({
  title: z.string().optional(),
  description: z.string().optional(),
  url: z.string().optional(),
  /** 0xRRGGBB as a number. */
  color: z.number().int().optional(),
  author: z.strictObject({ name: z.string() }).optional(),
  image: z.strictObject({ url: z.string() }).optional(),
  thumbnail: z.strictObject({ url: z.string() }).optional(),
  footer: z.strictObject({ text: z.string() }).optional(),
});
export type PayloadEmbed = z.infer<typeof PayloadEmbed>;

/** A link button opens [url]; an action button asks the app to call an API (open_ticket: POST /v1/orgs/:orgId/tickets). */
export const PayloadButton = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("link"), label: z.string().nullable(), emoji: z.string().nullable(), url: z.string() }),
  z.strictObject({ kind: z.literal("action"), action: z.enum(["open_ticket", "close_ticket"]), label: z.string().nullable(), emoji: z.string().nullable(), panelId: z.string().optional() }),
]);
export type PayloadButton = z.infer<typeof PayloadButton>;

/** Who posted: the webhook, with its name and picture at the time (or the poster's overrides). */
export const PayloadWebhook = z.strictObject({ id: z.string(), name: z.string(), avatarUrl: z.string().nullable() });

// ───────────── Managing webhooks ─────────────

export const ChannelWebhooksParams = z.object({ orgId: z.string().min(1).max(64), channelId: z.string().min(1).max(64) });
export const ChannelWebhookParams = ChannelWebhooksParams.extend({ webhookId: z.string().min(1).max(64) });
export const WebhookIdParams = z.object({ webhookId: z.string().min(1).max(64) });
export const WebhookTokenParams = z.object({ webhookId: z.string().min(1).max(64), token: z.string().min(1).max(200) });

export const WebhookCreateBody = z.strictObject({ name: z.string().trim().min(1).max(L.name).optional() });
export const WebhookRenameBody = z.strictObject({ name: z.string().trim().min(1).max(L.name) });

export const WebhookView = z.strictObject({
  id: z.string(),
  channelId: z.string(),
  name: z.string(),
  /** "/v1/webhooks/:id/avatar?rev=…" (fetched with the person's session), or null for the standard picture. */
  avatarUrl: z.string().nullable(),
  createdBy: z.strictObject({ id: z.string(), displayName: z.string() }).nullable(),
  createdAt: zTime,
  tokenRotatedAt: zTime,
  /** When something last posted through it; null: "Not used yet". */
  lastUsedAt: zTime.nullable(),
});

export const WebhookList = z.strictObject({ webhooks: z.array(WebhookView), limit: z.number().int() });
export const WebhookOne = z.strictObject({ webhook: WebhookView });
/** The secret token is shown here only: the address is <API base>/v1/webhooks/<webhook.id>/<token>. */
export const WebhookWithToken = z.strictObject({ webhook: WebhookView, token: z.string() });
export const WebhookDeleted = z.strictObject({ deleted: z.literal(true) });
export const WebhookPosted = z.strictObject({ id: z.string(), channelId: z.string(), serverTs: zTime });

const tag = "webhooks";
const base = "/v1/orgs/:orgId/channels/:channelId/webhooks";
const manage = ["not_found", "forbidden", "feature_disabled"] as const;

export const webhookRoutes = [
  route({ method: "GET", url: base, tag, summary: "A channel's webhooks (holders of webhooks.manage).", auth: true, params: ChannelWebhooksParams, response: WebhookList, errors: [...manage] }),
  route({
    method: "POST",
    url: base,
    tag,
    summary: "Make a webhook (a friendly name when none is given); its token is shown this once.",
    auth: true,
    params: ChannelWebhooksParams,
    body: WebhookCreateBody,
    response: WebhookWithToken,
    status: 201,
    errors: [...manage, "webhook_channel", "webhook_limit"],
  }),
  route({ method: "PATCH", url: `${base}/:webhookId`, tag, summary: "Rename a webhook.", auth: true, params: ChannelWebhookParams, body: WebhookRenameBody, response: WebhookOne, errors: [...manage] }),
  route({
    method: "PUT",
    url: `${base}/:webhookId/avatar`,
    tag,
    summary: "Set a webhook's picture (a JPEG, or an animated GIF or WebP, like a community icon).",
    auth: true,
    params: ChannelWebhookParams,
    binary: "request",
    response: WebhookOne,
    errors: [...manage, "too_large"],
  }),
  route({ method: "DELETE", url: `${base}/:webhookId/avatar`, tag, summary: "Back to the standard picture.", auth: true, params: ChannelWebhookParams, response: WebhookOne, errors: [...manage] }),
  route({ method: "POST", url: `${base}/:webhookId/token`, tag, summary: "A new address: the old token stops working; the new one is shown this once.", auth: true, params: ChannelWebhookParams, response: WebhookWithToken, errors: [...manage] }),
  route({ method: "DELETE", url: `${base}/:webhookId`, tag, summary: "Delete a webhook: its address stops working, what it posted stays.", auth: true, params: ChannelWebhookParams, response: WebhookDeleted, errors: [...manage] }),
  route({
    method: "POST",
    url: `${base}/:webhookId/post`,
    tag,
    summary: "Make a post: the in-app builder posts through a webhook (same body as the webhook's address).",
    auth: true,
    params: ChannelWebhookParams,
    body: WebhookMessageBody,
    response: WebhookPosted,
    errors: [...manage, "voice_channel"],
  }),
  route({ method: "GET", url: "/v1/webhooks/:webhookId/avatar", tag, summary: "A webhook's picture (members who can see its channel).", auth: true, params: WebhookIdParams, binary: "response", response: z.unknown(), errors: ["not_found"] }),
  route({
    method: "POST",
    url: "/v1/webhooks/:webhookId/:token",
    tag,
    summary: "Post through a webhook's secret address (no session; Discord's webhook JSON). Rate limited per webhook.",
    auth: false,
    params: WebhookTokenParams,
    body: WebhookMessageBody,
    response: WebhookPosted,
    errors: ["not_found", "forbidden", "feature_disabled", "voice_channel"],
  }),
];
