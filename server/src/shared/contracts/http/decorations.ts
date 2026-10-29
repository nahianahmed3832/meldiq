import { z } from "zod/v4";
import { zTime } from "./primitives.js";
import { route } from "./route.js";

/**
 * Profile decorations (API 0.61.0, docs/PROFILE_DECORATIONS.md): Meldiq's own (images the server ships) and ones people
 * make and send in, shown to everyone once a Meldiq operator approves them. A decoration is a square image whose middle
 * circle (1/1.2 of its side) is left empty for the avatar; the apps draw it 1.2 times the avatar's size, centred on it.
 * The six frames the apps draw themselves (PROFILE_DECORATIONS in users.ts) stay as they were.
 */

/** Meldiq's own ids (lowercase words) or a community one ("c_" and 16 letters or digits). */
export const DECORATION_ID = /^(?:[a-z0-9-]{2,32}|c_[a-z0-9]{16})$/;
export const zDecorationId = z.string().regex(DECORATION_ID, "Not a decoration id");

/** A decoration's name: one line, 2 to 32 characters. */
export const zDecorationName = z
  .string()
  .trim()
  .min(2, "Give it a name of at least 2 characters")
  .max(32, "Names can be up to 32 characters")
  .refine((v) => !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(v), "A name is one line of plain text");

export const DecorationCreator = z.strictObject({ userId: z.string(), username: z.string().nullable(), displayName: z.string() });

export const Decoration = z.strictObject({
  id: zDecorationId,
  name: z.string(),
  /** "meldiq": Meldiq's own; "community": made by [creator]. */
  kind: z.enum(["meldiq", "community"]),
  animated: z.boolean(),
  /** Relative to the API's origin; anyone may load it, and it never changes for an id. */
  imageUrl: z.string(),
  /** Who made it; null for Meldiq's own, or when the account is gone. */
  creator: DecorationCreator.nullable(),
});
export type Decoration = z.infer<typeof Decoration>;

export const DecorationCatalog = z.strictObject({
  decorations: z.array(Decoration),
  /** The frames the apps draw themselves, still valid to wear. */
  classic: z.array(z.string()),
  /** The guide image for people making their own: the avatar's circle and the strip above the name. */
  templateUrl: z.string(),
});

export const DecorationStatus = z.enum(["pending", "approved", "rejected", "removed"]);
export type DecorationStatus = z.infer<typeof DecorationStatus>;

/** One of your own submissions. */
export const DecorationSubmission = z.strictObject({
  id: zDecorationId,
  name: z.string(),
  status: DecorationStatus,
  /** Why it was turned down or taken down. */
  reason: z.string().nullable(),
  animated: z.boolean(),
  /** Needs your sign-in until it's approved (GET /v2/decorations/mine/:id/image). */
  imageUrl: z.string(),
  /** How many people wear it now. */
  wearers: z.number().int().nonnegative(),
  createdAt: zTime,
  reviewedAt: zTime.nullable(),
});

export const MyDecorations = z.strictObject({
  submissions: z.array(DecorationSubmission),
  /** Whether you have a decoration approved (the Artist badge). */
  artist: z.boolean(),
  /** How many can wait for review at once: 3, or 6 once you're an artist. */
  pendingLimit: z.number().int(),
  pending: z.number().int(),
});

export const SubmitDecorationQuery = z.strictObject({
  name: zDecorationName,
  /** The sender's statement that they made it themselves. */
  original: z.literal("true", { error: "Confirm that you made this yourself" }),
});

const decoration = (extra: Omit<Parameters<typeof route>[0], "tag">) => route({ tag: "users", ...extra });

export const decorationRoutes = [
  decoration({ method: "GET", url: "/v2/decorations", auth: true, summary: "Every decoration anyone can wear: Meldiq's own, then approved community ones (newest first).", response: DecorationCatalog }),
  decoration({
    method: "GET",
    url: "/v2/decorations/:id/image",
    auth: false,
    summary: "A decoration's image (WebP, PNG or GIF), for Meldiq's own and approved ones; cached for good.",
    params: z.strictObject({ id: zDecorationId }),
    binary: "response",
    response: z.unknown(),
    errors: ["not_found"],
  }),
  decoration({ method: "GET", url: "/v2/decorations/template", auth: false, summary: "The template for making a decoration (PNG).", binary: "response", response: z.unknown() }),
  decoration({ method: "GET", url: "/v2/decorations/mine", auth: true, summary: "Your submissions and their review, and how many more can wait.", response: MyDecorations }),
  decoration({
    method: "GET",
    url: "/v2/decorations/mine/:id/image",
    auth: true,
    summary: "The image of one of your own submissions, whatever its status.",
    params: z.strictObject({ id: zDecorationId }),
    binary: "response",
    response: z.unknown(),
    errors: ["not_found"],
  }),
  decoration({
    method: "POST",
    url: "/v2/decorations",
    auth: true,
    summary: "Send in a decoration you made: a square PNG, WebP or GIF (128 to 1024 px, up to 1.5 MB), as application/octet-stream. It waits for review.",
    query: SubmitDecorationQuery,
    binary: "request",
    status: 201,
    response: z.strictObject({ submission: DecorationSubmission }),
    errors: ["too_large", "limit_reached", "storage_unavailable"],
  }),
  decoration({
    method: "DELETE",
    url: "/v2/decorations/mine/:id",
    auth: true,
    summary: "Withdraw one of your submissions; an approved one leaves the catalog and comes off everyone wearing it.",
    params: z.strictObject({ id: zDecorationId }),
    response: z.strictObject({ ok: z.literal(true) }),
    errors: ["not_found"],
  }),
  decoration({
    method: "GET",
    url: "/v2/users/:id/decorations",
    auth: true,
    summary: "A person's approved decorations, to try on and wear.",
    params: z.strictObject({ id: z.string() }),
    response: z.strictObject({ decorations: z.array(Decoration) }),
    errors: ["not_found"],
  }),
];
