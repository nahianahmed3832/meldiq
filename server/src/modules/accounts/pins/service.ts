import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppContext } from "../../../app/context.js";
import type {
  CommunityPin,
  ProfilePin,
} from "../../../shared/contracts/http/pins.js";
import { ApiError, badRequest, notFound } from "../../../shared/errors.js";
import { now } from "../../../shared/utilities/util.js";
import { deleteBlobNow } from "../../files/index.js";
import { isBugHunter } from "../bugReports.js";
import {
  gifInfo,
  type ImageInfo,
  pngInfo,
  sniff,
  webpInfo,
} from "../mediaFormats.js";
import { storePhoto } from "../photos.js";
import { announceProfileChange } from "../profileEvents.js";
import { membershipsOf, orgRecord } from "../../organizations/index.js";
import {
  BETA_ENDS_AT,
  EXPLORER_COMMUNITIES,
  FOUNDER_MEMBERS,
  MELDIQ_PIN_IDS,
  MELDIQ_PINS,
  YEAR_MS,
} from "./builtins.js";
import type { PinStore, StoredAward, StoredPin } from "./store.js";

/** What a community pin's image may be, and how many a community and a profile have (docs/PROFILE_PINS.md). */
export const PIN_LIMITS = {
  bytes: 512 * 1024,
  minSide: 64,
  maxSide: 512,
  maxFrames: 300,
  perCommunity: 30,
  /** Community pins shown on one profile, newest first (Meldiq's own are always shown). */
  perProfile: 24,
} as const;

const MIME = {
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
} as const;

export const pinBlob = (id: string) => `pin-${id}`;
export const pinImageUrl = (id: string) => `/v2/pins/${id}/image`;

/** Meldiq's own images (assets/pins beside src/ or dist/), or PINS_DIR. */
export function pinsDir(): string {
  return (
    process.env.PINS_DIR ??
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../assets/pins",
    )
  );
}

function newPinId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return `p_${[...crypto.randomBytes(16)].map((b) => alphabet[b % alphabet.length]).join("")}`;
}

function pinImage(buf: Buffer): {
  format: StoredPin["format"];
  info: ImageInfo;
} {
  const kind = sniff(buf);
  if (kind !== "png" && kind !== "webp" && kind !== "gif")
    throw badRequest("Pins are PNG, WebP or GIF images.");
  const info =
    kind === "png"
      ? pngInfo(buf)
      : kind === "webp"
        ? webpInfo(buf)
        : gifInfo(buf);
  if (!info)
    throw badRequest(
      "That image is damaged or not a supported PNG, WebP or GIF.",
    );
  const L = PIN_LIMITS;
  if (info.width !== info.height)
    throw badRequest(
      `Pins are square; that image is ${info.width} × ${info.height}.`,
    );
  if (info.width < L.minSide || info.width > L.maxSide)
    throw badRequest(
      `Pins are ${L.minSide} to ${L.maxSide} pixels square (128 × 128 works well); that one is ${info.width}.`,
    );
  if (info.frames > L.maxFrames)
    throw badRequest(
      `That animation has ${info.frames} frames; the most is ${L.maxFrames}.`,
    );
  return { format: kind, info };
}

/**
 * Profile pins (API 0.64.0, docs/PROFILE_PINS.md). Meldiq's own are worked out from what the server knows each time a
 * profile is built; a community's are kept in the store and held here in memory too (profiles are built synchronously),
 * every change written to the store first.
 */
export class PinService {
  private readonly pinsById = new Map<string, StoredPin>();
  /** Awards per user, and per pin. */
  private readonly byUser = new Map<string, Map<string, StoredAward>>();
  private readonly byPin = new Map<string, Map<string, StoredAward>>();

  constructor(
    private readonly ctx: AppContext,
    readonly store: PinStore,
  ) {}

  async load(): Promise<void> {
    for (const p of await this.store.pins()) this.pinsById.set(p.id, p);
    for (const a of await this.store.awards())
      if (this.pinsById.has(a.pinId)) this.hold(a);
  }

  /** Meldiq's own, with how each is earned. */
  catalog() {
    return [
      ...MELDIQ_PINS,
      ...(this.ctx.points?.achievementCatalog() ?? []),
    ].map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      imageUrl: pinImageUrl(p.id),
    }));
  }

  /** The pins [userId]'s profile shows to [viewer]: Meldiq's own they've earned, then community ones, newest first. */
  profilePins(userId: string, viewer: string): ProfilePin[] {
    return [...this.earned(userId), ...this.communityPinsOf(userId, viewer)];
  }

  /** Meldiq's pins [userId] has earned, in Meldiq's order. */
  earned(userId: string): ProfilePin[] {
    const u = this.ctx.identity.get<{ id: string; created_at: number }>(
      "users",
      { id: userId },
    );
    if (!u) return [];
    const t = now();
    const memberships = membershipsOf(this.ctx.ws, userId);
    const joined = memberships.map((m) => m.joined_at).sort((a, b) => a - b);
    const owns = memberships
      .filter((m) => m.role === "OWNER")
      .some(
        (m) =>
          (orgRecord(this.ctx.ws, m.org_id)?.members ?? 0) >= FOUNDER_MEMBERS,
      );
    const sparks = this.ctx.mojo?.assignmentsOf(userId) ?? [];
    const has: Record<string, { since: number | null } | null> = {
      "early-member":
        u.created_at < BETA_ENDS_AT ? { since: u.created_at } : null,
      "one-year":
        t - u.created_at >= YEAR_MS ? { since: u.created_at + YEAR_MS } : null,
      explorer:
        joined.length >= EXPLORER_COMMUNITIES
          ? { since: joined[EXPLORER_COMMUNITIES - 1] }
          : null,
      founder: owns ? { since: null } : null,
      "spark-giver":
        sparks.length > 0
          ? { since: Math.min(...sparks.map((s) => s.assigned_at)) }
          : null,
      artist: this.ctx.decorations?.isArtist(userId) ? { since: null } : null,
      "bug-hunter": isBugHunter(this.ctx.safety, userId)
        ? { since: null }
        : null,
    };
    const original = MELDIQ_PINS.flatMap((p) => {
      const got = has[p.id];
      return got
        ? [
            {
              id: p.id,
              kind: "meldiq" as const,
              name: p.name,
              description: p.description,
              imageUrl: pinImageUrl(p.id),
              animated: false,
              since: got.since,
            },
          ]
        : [];
    });
    return [
      ...original,
      ...(this.ctx.points?.earnedAchievements(userId) ?? []).map((a) => ({
        id: a.id,
        kind: "meldiq" as const,
        name: a.name,
        description: a.description,
        imageUrl: pinImageUrl(a.id),
        animated: false,
        since: a.earnedAt,
      })),
    ];
  }

  /**
   * Community pins [userId] holds, from communities they're still in. Shown to everyone when the community is public;
   * from a private one, only to its members (a pin mustn't tell strangers who's in a private community).
   */
  private communityPinsOf(userId: string, viewer: string): ProfilePin[] {
    const awards = [...(this.byUser.get(userId)?.values() ?? [])].sort(
      (a, b) => b.awardedAt - a.awardedAt,
    );
    const out: ProfilePin[] = [];
    for (const a of awards) {
      if (out.length >= PIN_LIMITS.perProfile) break;
      const p = this.pinsById.get(a.pinId);
      const org = p && orgRecord(this.ctx.ws, p.orgId);
      if (!p || !org || !this.ctx.authz.orgRole(org.id, userId)) continue;
      if (
        org.visibility !== "public" &&
        viewer !== userId &&
        !this.ctx.authz.orgRole(org.id, viewer)
      )
        continue;
      out.push({
        id: p.id,
        kind: "community",
        name: p.name,
        description: p.description,
        imageUrl: pinImageUrl(p.id),
        animated: p.animated,
        community: { id: org.id, name: org.name },
        since: a.awardedAt,
      });
    }
    return out;
  }

  /** A community's pins, newest first. */
  communityPins(orgId: string): CommunityPin[] {
    return [...this.pinsById.values()]
      .filter((p) => p.orgId === orgId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((p) => this.view(p));
  }

  view(p: StoredPin): CommunityPin {
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      imageUrl: pinImageUrl(p.id),
      animated: p.animated,
      holders: this.byPin.get(p.id)?.size ?? 0,
      createdAt: p.createdAt,
    };
  }

  /** [orgId]'s pin [pinId], or 404. */
  pinOf(orgId: string, pinId: string): StoredPin {
    const p = this.pinsById.get(pinId);
    if (!p || p.orgId !== orgId) throw notFound("Pin not found");
    return p;
  }

  holders(pinId: string) {
    return [...(this.byPin.get(pinId)?.values() ?? [])]
      .sort((a, b) => b.awardedAt - a.awardedAt)
      .flatMap((a) => {
        const u = this.ctx.identity.get<{
          id: string;
          username: string | null;
          display_name: string;
        }>("users", { id: a.userId, disabled_at: null });
        return u
          ? [
              {
                userId: u.id,
                username: u.username,
                displayName: u.display_name,
                awardedAt: a.awardedAt,
              },
            ]
          : [];
      });
  }

  async create(
    orgId: string,
    actor: string,
    name: string,
    description: string | null,
    buf: Buffer,
  ): Promise<StoredPin> {
    const { format, info } = pinImage(buf);
    if (this.communityPins(orgId).length >= PIN_LIMITS.perCommunity)
      throw new ApiError(
        409,
        "limit_reached",
        `A community can have up to ${PIN_LIMITS.perCommunity} pins. Delete one first.`,
      );
    const p: StoredPin = {
      id: newPinId(),
      orgId,
      name,
      description: description || null,
      format,
      animated: info.frames > 1,
      createdBy: actor,
      createdAt: now(),
    };
    await storePhoto(this.ctx, pinBlob(p.id), buf);
    try {
      await this.store.insertPin(p);
    } catch (e) {
      await deleteBlobNow(this.ctx, "profile-photos", pinBlob(p.id));
      throw e;
    }
    this.pinsById.set(p.id, p);
    this.ctx.audit({
      actorId: actor,
      orgId,
      action: "pin.create",
      detail: p.id,
    });
    return p;
  }

  /** Deletes the pin; it comes off everyone who had it, and their contacts' apps hear of it. */
  async remove(p: StoredPin, actor: string): Promise<void> {
    const had = [...(this.byPin.get(p.id)?.keys() ?? [])];
    await this.store.removePin(p.id);
    this.pinsById.delete(p.id);
    for (const userId of had) this.release(p.id, userId);
    await deleteBlobNow(this.ctx, "profile-photos", pinBlob(p.id));
    this.ctx.audit({
      actorId: actor,
      orgId: p.orgId,
      action: "pin.delete",
      detail: p.id,
    });
    for (const userId of had) announceProfileChange(this.ctx, userId);
  }

  async award(p: StoredPin, userId: string, actor: string): Promise<void> {
    if (!this.ctx.authz.orgRole(p.orgId, userId))
      throw notFound("Member not found");
    const a: StoredAward = {
      pinId: p.id,
      orgId: p.orgId,
      userId,
      awardedBy: actor,
      awardedAt: now(),
    };
    if (!(await this.store.award(a))) return;
    this.hold(a);
    this.ctx.audit({
      actorId: actor,
      orgId: p.orgId,
      action: "pin.award",
      detail: `${p.id} ${userId}`,
    });
    announceProfileChange(this.ctx, userId);
  }

  async revoke(p: StoredPin, userId: string, actor: string): Promise<void> {
    if (!(await this.store.revoke(p.id, userId))) return;
    this.release(p.id, userId);
    this.ctx.audit({
      actorId: actor,
      orgId: p.orgId,
      action: "pin.revoke",
      detail: `${p.id} ${userId}`,
    });
    announceProfileChange(this.ctx, userId);
  }

  /** A pin's image, for anyone: Meldiq's own, or a community's while it exists. */
  async image(
    id: string,
  ): Promise<{
    type: string;
    body: NodeJS.ReadableStream;
    immutable: boolean;
  } | null> {
    if (
      MELDIQ_PIN_IDS.has(id) ||
      this.ctx.points?.achievementCatalog().some((a) => a.id === id)
    ) {
      const file = path.join(pinsDir(), `${id}.webp`);
      return fs.existsSync(file)
        ? {
            type: "image/webp",
            body: fs.createReadStream(file),
            immutable: false,
          }
        : null;
    }
    const p = this.pinsById.get(id);
    const stream = p
      ? await this.ctx.blobs.get("profile-photos", pinBlob(p.id))
      : null;
    return p && stream
      ? { type: MIME[p.format], body: stream, immutable: true }
      : null;
  }

  private hold(a: StoredAward): void {
    const put = (
      m: Map<string, Map<string, StoredAward>>,
      k: string,
      sub: string,
    ) => {
      const inner = m.get(k) ?? new Map<string, StoredAward>();
      inner.set(sub, a);
      m.set(k, inner);
    };
    put(this.byUser, a.userId, a.pinId);
    put(this.byPin, a.pinId, a.userId);
  }

  private release(pinId: string, userId: string): void {
    this.byUser.get(userId)?.delete(pinId);
    this.byPin.get(pinId)?.delete(userId);
  }
}
