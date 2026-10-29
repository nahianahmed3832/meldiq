import { z } from "zod/v4";
import { zTime } from "./primitives.js";
import { route } from "./route.js";

/**
 * Profile pins (API 0.64.0, docs/PROFILE_PINS.md): a row of small badges on a person's profile. Meldiq's own are earned
 * by reaching milestones on Meldiq (the server decides; nobody hands them out). A community's are designed by its owners
 * and admins and given to members they choose. Every pin is a small square image anyone may load.
 */

/** Meldiq's own ids (lowercase words) or a community pin ("p_" and 16 letters or digits). */
export const PIN_ID = /^(?:[a-z0-9-]{2,32}|p_[a-z0-9]{16})$/;
export const zPinId = z.string().regex(PIN_ID, "Not a pin id");
export const zCommunityPinId = z.string().regex(/^p_[a-z0-9]{16}$/, "Not a community pin id");

const oneLine = (v: string) => !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(v);
export const zPinName = z.string().trim().min(2, "Give it a name of at least 2 characters").max(32, "Names can be up to 32 characters").refine(oneLine, "A name is one line of plain text");
export const zPinDescription = z.string().trim().max(120, "Descriptions can be up to 120 characters").refine(oneLine, "A description is one line of plain text");

/** A pin as shown on a profile. */
export const ProfilePin = z.strictObject({
  id: zPinId,
  /** "meldiq": earned on Meldiq; "community": given by [community]. */
  kind: z.enum(["meldiq", "community"]),
  name: z.string(),
  /** What it's for (Meldiq's say how it's earned). */
  description: z.string().nullable(),
  /** Relative to the API's origin; anyone may load it, and it never changes for an id. */
  imageUrl: z.string(),
  animated: z.boolean(),
  /** The community that gave it; absent for Meldiq's own. */
  community: z.strictObject({ id: z.string(), name: z.string() }).optional(),
  /** When it was earned or given (Meldiq's: when the milestone was reached, where known). */
  since: zTime.nullable(),
});
export type ProfilePin = z.infer<typeof ProfilePin>;

/** One of a community's pins, for its members. */
export const CommunityPin = z.strictObject({
  id: zCommunityPinId,
  name: z.string(),
  description: z.string().nullable(),
  imageUrl: z.string(),
  animated: z.boolean(),
  /** How many members have it. */
  holders: z.number().int().nonnegative(),
  createdAt: zTime,
});
export type CommunityPin = z.infer<typeof CommunityPin>;

export const CommunityPins = z.strictObject({
  pins: z.array(CommunityPin),
  /** Whether you can make, give and take back this community's pins (owners and admins). */
  canManage: z.boolean(),
  /** How many pins a community can have. */
  limit: z.number().int(),
});

export const PinHolder = z.strictObject({ userId: z.string(), username: z.string().nullable(), displayName: z.string(), awardedAt: zTime });
export const PinHolders = z.strictObject({ holders: z.array(PinHolder) });

/** Meldiq's own pins and how each is earned, so the apps can show what's still to earn. */
export const MeldiqPinCatalog = z.strictObject({
  pins: z.array(z.strictObject({ id: zPinId, name: z.string(), description: z.string(), imageUrl: z.string() })),
});

export const CreatePinQuery = z.strictObject({ name: zPinName, description: zPinDescription.optional() });

const orgParams = z.strictObject({ orgId: z.string() });
const pinParams = z.strictObject({ orgId: z.string(), pinId: zCommunityPinId });
const holderParams = z.strictObject({ orgId: z.string(), pinId: zCommunityPinId, userId: z.string() });

const pin = (extra: Omit<Parameters<typeof route>[0], "tag">) => route({ tag: "users", ...extra });

export const pinRoutes = [
  pin({ method: "GET", url: "/v2/pins", auth: true, summary: "Meldiq's own pins and how each is earned.", response: MeldiqPinCatalog }),
  pin({
    method: "GET",
    url: "/v2/pins/:id/image",
    auth: false,
    summary: "A pin's image (WebP, PNG or GIF): Meldiq's own, or a community's while it exists; cached for good.",
    params: z.strictObject({ id: zPinId }),
    binary: "response",
    response: z.unknown(),
    errors: ["not_found"],
  }),
  pin({ method: "GET", url: "/v2/orgs/:orgId/pins", auth: true, summary: "A community's pins, for its members.", params: orgParams, response: CommunityPins, errors: ["not_found"] }),
  pin({
    method: "POST",
    url: "/v2/orgs/:orgId/pins",
    auth: true,
    summary: "Make a community pin (owners and admins): a square PNG, WebP or GIF (64 to 512 px, up to 512 KB), as application/octet-stream.",
    params: orgParams,
    query: CreatePinQuery,
    binary: "request",
    status: 201,
    response: z.strictObject({ pin: CommunityPin }),
    errors: ["forbidden", "not_found", "too_large", "limit_reached", "storage_unavailable"],
  }),
  pin({
    method: "DELETE",
    url: "/v2/orgs/:orgId/pins/:pinId",
    auth: true,
    summary: "Delete a community pin (owners and admins); it comes off everyone who has it.",
    params: pinParams,
    response: z.strictObject({ ok: z.literal(true) }),
    errors: ["forbidden", "not_found"],
  }),
  pin({ method: "GET", url: "/v2/orgs/:orgId/pins/:pinId/holders", auth: true, summary: "Who has a community pin, newest first.", params: pinParams, response: PinHolders, errors: ["not_found"] }),
  pin({
    method: "PUT",
    url: "/v2/orgs/:orgId/pins/:pinId/holders/:userId",
    auth: true,
    summary: "Give a community pin to a member (owners and admins); giving it again changes nothing.",
    params: holderParams,
    response: z.strictObject({ ok: z.literal(true) }),
    errors: ["forbidden", "not_found"],
  }),
  pin({
    method: "DELETE",
    url: "/v2/orgs/:orgId/pins/:pinId/holders/:userId",
    auth: true,
    summary: "Take a community pin back from someone (owners and admins).",
    params: holderParams,
    response: z.strictObject({ ok: z.literal(true) }),
    errors: ["forbidden", "not_found"],
  }),
];
