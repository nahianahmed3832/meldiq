import crypto from "node:crypto";
import type { z } from "zod/v4";
import { type PayloadButton, type PayloadEmbed, WEBHOOK_LIMITS, type WebhookEmbedInput, type WebhookMessageBody } from "../../../shared/contracts/http/webhooks.js";
import { badRequest } from "../../../shared/errors.js";

/**
 * Discord's webhook JSON turned into a Meldiq message payload (community parity batch C). Pure, so its rules are tested
 * on their own. The schema (shared/contracts/http/webhooks.ts) has already checked types, lengths and https addresses;
 * this checks what spans fields and keeps only what apps show:
 *
 *   { type: "text", text, embeds?, buttons?, webhook: { id, name, avatarUrl }, title?, textFromEmbeds? }
 *
 * `text` is the content; without content it's made from the boxes (`textFromEmbeds: true`) so older apps, previews and
 * search still have words, and apps that show boxes don't show that text again. A forum channel's post takes
 * `thread_name` as its title, and its text starts with the title and a blank line, as forum posts do.
 */

export interface PostedAs {
  id: string;
  name: string;
  avatarUrl: string | null;
}

type EmbedInput = z.infer<typeof WebhookEmbedInput>;

const ADJECTIVES = ["Brave", "Cosy", "Lucky", "Sunny", "Swift", "Quiet", "Clever", "Merry", "Bold", "Gentle", "Jolly", "Bright", "Nimble", "Mellow", "Plucky", "Witty"];
const NOUNS = ["Otter", "Lantern", "Kettle", "Comet", "Falcon", "Pebble", "Badger", "Maple", "Harbour", "Compass", "Puffin", "Teapot", "Fox", "Beacon", "Walrus", "Meadow"];

/** A friendly name for a new webhook, like "Plucky Puffin". */
export function friendlyWebhookName(): string {
  return `${ADJECTIVES[crypto.randomInt(ADJECTIVES.length)]} ${NOUNS[crypto.randomInt(NOUNS.length)]}`;
}

/** "#RRGGBB" or "RRGGBB" as 0xRRGGBB; numbers stay as they are. */
export function colorValue(c: number | string): number {
  return typeof c === "number" ? c : Number.parseInt(c.replace(/^#/, ""), 16);
}

const nonEmpty = (s: string | null | undefined): s is string => typeof s === "string" && s.trim().length > 0;

function embedOf(e: EmbedInput, i: number): PayloadEmbed {
  const out: PayloadEmbed = {
    ...(nonEmpty(e.title) ? { title: e.title } : {}),
    ...(nonEmpty(e.description) ? { description: e.description } : {}),
    ...(e.url ? { url: e.url } : {}),
    ...(e.color !== null && e.color !== undefined ? { color: colorValue(e.color) } : {}),
    ...(nonEmpty(e.author?.name) ? { author: { name: e.author!.name } } : {}),
    ...(e.image ? { image: { url: e.image.url } } : {}),
    ...(e.thumbnail ? { thumbnail: { url: e.thumbnail.url } } : {}),
    ...(nonEmpty(e.footer?.text) ? { footer: { text: e.footer!.text } } : {}),
  };
  if (!out.title && !out.description && !out.author && !out.image && !out.thumbnail && !out.footer) {
    throw badRequest("Invalid request", [{ path: `embeds.${i}`, message: "A box needs a title, text, picture, author or footer" }]);
  }
  return out;
}

const embedTextLength = (e: PayloadEmbed) => (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.author?.name.length ?? 0) + (e.footer?.text.length ?? 0);

/** The message's link buttons, from the simple list and Discord's components, in that order. */
function buttonsOf(body: WebhookMessageBody): PayloadButton[] {
  const simple = (body.buttons ?? []).map((b) => ({ label: b.label?.trim() || null, emoji: b.emoji?.trim() || null, url: b.url }));
  const discord = (body.components ?? []).flatMap((row) => row.components).map((b) => ({ label: b.label?.trim() || null, emoji: b.emoji?.name?.trim() || null, url: b.url }));
  const all = [...simple, ...discord];
  if (all.length > WEBHOOK_LIMITS.buttons) throw badRequest("Invalid request", [{ path: "buttons", message: `A post can have up to ${WEBHOOK_LIMITS.buttons} buttons` }]);
  return all.map((b, i) => {
    if (!b.label && !b.emoji) throw badRequest("Invalid request", [{ path: `buttons.${i}`, message: "A button needs a label or an emoji" }]);
    return { kind: "link" as const, ...b };
  });
}

/** Words for apps that can't show boxes: each box's title and text. */
function textFromEmbeds(embeds: readonly PayloadEmbed[]): string {
  const text = embeds.map((e) => [e.title, e.description].filter(nonEmpty).join("\n")).filter(nonEmpty).join("\n\n");
  return text.length > WEBHOOK_LIMITS.content ? `${text.slice(0, WEBHOOK_LIMITS.content - 1).trimEnd()}…` : text;
}

/** The payload a webhook posts, for a channel that is a forum when [forum]. Throws 400 for what the schema can't see. */
export function webhookPayload(body: WebhookMessageBody, as: PostedAs, forum: boolean): Record<string, unknown> & { type: string } {
  const { embeds, buttons } = richPostFields(body);
  const content = body.content ?? "";
  if (!nonEmpty(content) && embeds.length === 0) throw badRequest("Invalid request", [{ path: "content", message: "Add some text or a box before posting" }]);
  const title = body.thread_name?.trim();
  if (forum && !title) throw badRequest("Invalid request", [{ path: "thread_name", message: "A post in a forum channel needs a title (thread_name)" }]);
  const words = nonEmpty(content) ? content : textFromEmbeds(embeds);
  return {
    type: "text",
    text: forum ? `${title}\n\n${words}` : words,
    ...(forum ? { title } : {}),
    ...(embeds.length ? { embeds } : {}),
    ...(buttons.length ? { buttons } : {}),
    ...(nonEmpty(content) ? {} : { textFromEmbeds: true }),
    webhook: { id: as.id, name: body.username?.trim() || as.name, avatarUrl: body.avatar_url ?? as.avatarUrl },
  };
}

/** Shared validated native boxes/link buttons, without creating a webhook identity or bypassing posting authority. */
export function richPostFields(body: WebhookMessageBody) {
  const embeds = (body.embeds ?? []).map(embedOf);
  if (embeds.reduce((n, e) => n + embedTextLength(e), 0) > WEBHOOK_LIMITS.embedText) {
    throw badRequest("Invalid request", [{ path: "embeds", message: `The boxes can hold up to ${WEBHOOK_LIMITS.embedText} characters together` }]);
  }
  const buttons = buttonsOf(body);
  return { embeds, buttons };
}
