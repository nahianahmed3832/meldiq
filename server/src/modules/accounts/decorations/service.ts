import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppContext } from "../../../app/context.js";
import type { Decoration, DecorationStatus } from "../../../shared/contracts/http/decorations.js";
import { PROFILE_DECORATIONS } from "../../../shared/contracts/http/users.js";
import { ApiError, badRequest, notFound } from "../../../shared/errors.js";
import { now } from "../../../shared/utilities/util.js";
import { deleteBlobNow } from "../../files/index.js";
import { gifInfo, type ImageInfo, pngInfo, sniff, webpInfo } from "../mediaFormats.js";
import { storePhoto } from "../photos.js";
import { announceProfileChange } from "../profileEvents.js";
import { styleOf } from "../profileMedia.js";
import { BUILTIN_DECORATIONS } from "./builtins.generated.js";
import type { DecorationStore, StoredDecoration } from "./store.js";

/** What a submission may be (docs/PROFILE_DECORATIONS.md). */
export const DECORATION_LIMITS = {
  bytes: 1536 * 1024,
  minSide: 128,
  maxSide: 1024,
  maxFrames: 300,
  /** Submissions that can wait for review at once; more once someone has one approved (the Artist badge). */
  pending: 3,
  artistPending: 6,
} as const;

/** The six frames the apps draw themselves (API 0.45.0), still worn as before. */
export const CLASSIC_DECORATIONS: readonly string[] = PROFILE_DECORATIONS;
const BUILTIN_IDS = new Set(BUILTIN_DECORATIONS.map((d) => d.id));
const MIME = { png: "image/png", webp: "image/webp", gif: "image/gif" } as const;

/** The blob of a submitted decoration's image, in the profile-photos store. */
export const decorationBlob = (id: string) => `deco-${id}`;
export const decorationImageUrl = (id: string) => `/v2/decorations/${id}/image`;

/** Meldiq's own images (assets/decorations beside src/ or dist/), or DECORATIONS_DIR. */
export function builtinDir(): string {
  return process.env.DECORATIONS_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../assets/decorations");
}

/** 16 lowercase letters and digits after "c_": unguessable, and plain enough for any app to keep as a string. */
function newDecorationId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(16);
  return `c_${[...bytes].map((b) => alphabet[b % alphabet.length]).join("")}`;
}

function imageInfo(buf: Buffer): { format: StoredDecoration["format"]; info: ImageInfo } {
  const kind = sniff(buf);
  const info = kind === "png" ? pngInfo(buf) : kind === "webp" ? webpInfo(buf) : kind === "gif" ? gifInfo(buf) : null;
  if (kind !== "png" && kind !== "webp" && kind !== "gif") throw badRequest("Decorations are PNG, WebP or GIF images.");
  if (!info) throw badRequest("That image is damaged or not a supported PNG, WebP or GIF.");
  const L = DECORATION_LIMITS;
  if (info.width !== info.height) throw badRequest(`Decorations are square; that image is ${info.width} × ${info.height}.`);
  if (info.width < L.minSide || info.width > L.maxSide) throw badRequest(`Decorations are ${L.minSide} to ${L.maxSide} pixels square (512 × 512 works best); that one is ${info.width}.`);
  if (info.frames > L.maxFrames) throw badRequest(`That animation has ${info.frames} frames; the most is ${L.maxFrames}.`);
  return { format: kind, info };
}

/**
 * Profile decorations (API 0.60.0, docs/PROFILE_DECORATIONS.md): Meldiq's own, and ones people make and send in. A
 * submission waits for an operator's review in the admin console; approved ones are shown to everyone with their maker's
 * name. The request path reads this in-memory copy of the approved ones (profiles are built synchronously); every change
 * is written to the store first.
 */
export class DecorationService {
  private readonly approvedById = new Map<string, StoredDecoration>();
  /** Approved decorations per creator: having any is the Artist badge. */
  private readonly approvedCount = new Map<string, number>();

  constructor(
    private readonly ctx: AppContext,
    readonly store: DecorationStore,
  ) {}

  async load(): Promise<void> {
    for (const d of await this.store.approved()) this.hold(d);
  }

  /** Whether [id] can be worn: a classic frame, one of Meldiq's own, or an approved community one. */
  wearable(id: string): boolean {
    return CLASSIC_DECORATIONS.includes(id) || BUILTIN_IDS.has(id) || this.approvedById.has(id);
  }

  isArtist(userId: string): boolean {
    return (this.approvedCount.get(userId) ?? 0) > 0;
  }

  /** Everything anyone can wear: Meldiq's own in their order, then community ones, newest first. */
  catalog(): Decoration[] {
    const own: Decoration[] = BUILTIN_DECORATIONS.map((d) => ({ id: d.id, name: d.name, kind: "meldiq", animated: d.animated, imageUrl: decorationImageUrl(d.id), creator: null }));
    const community = [...this.approvedById.values()].sort((a, b) => b.createdAt - a.createdAt).map((d) => this.view(d));
    return [...own, ...community];
  }

  /** [userId]'s approved decorations, newest first. */
  creations(userId: string): Decoration[] {
    return [...this.approvedById.values()].filter((d) => d.creatorId === userId).sort((a, b) => b.createdAt - a.createdAt).map((d) => this.view(d));
  }

  view(d: StoredDecoration): Decoration {
    const u = this.ctx.identity.get<{ id: string; username: string | null; display_name: string; disabled_at: number | null }>("users", { id: d.creatorId });
    const creator = u && !u.disabled_at ? { userId: u.id, username: u.username, displayName: u.display_name } : null;
    return { id: d.id, name: d.name, kind: "community", animated: d.animated, imageUrl: decorationImageUrl(d.id), creator };
  }

  submissionView(d: StoredDecoration) {
    return {
      id: d.id,
      name: d.name,
      status: d.status,
      reason: d.reason,
      animated: d.animated,
      imageUrl: d.status === "approved" ? decorationImageUrl(d.id) : `/v2/decorations/mine/${d.id}/image`,
      wearers: d.wearers,
      createdAt: d.createdAt,
      reviewedAt: d.reviewedAt,
    };
  }

  async mine(userId: string) {
    const submissions = await this.store.byCreator(userId);
    return {
      submissions: submissions.map((d) => this.submissionView(d)),
      artist: this.isArtist(userId),
      pendingLimit: this.pendingLimit(userId),
      pending: submissions.filter((d) => d.status === "pending").length,
    };
  }

  /** Checks and stores [buf] as [userId]'s new submission, waiting for review. */
  async submit(userId: string, name: string, buf: Buffer): Promise<StoredDecoration> {
    const { format, info } = imageInfo(buf);
    const limit = this.pendingLimit(userId);
    if ((await this.store.countPending(userId)) >= limit) {
      throw new ApiError(409, "limit_reached", `You have ${limit} decorations waiting for review. Wait until they're reviewed, or withdraw one.`);
    }
    const d: StoredDecoration = {
      id: newDecorationId(),
      creatorId: userId,
      name,
      status: "pending",
      format,
      animated: info.frames > 1,
      size: buf.length,
      createdAt: now(),
      reviewedAt: null,
      reviewedBy: null,
      reason: null,
      wearers: 0,
    };
    await storePhoto(this.ctx, decorationBlob(d.id), buf);
    try {
      await this.store.insert(d);
    } catch (e) {
      await deleteBlobNow(this.ctx, "profile-photos", decorationBlob(d.id));
      throw e;
    }
    this.ctx.audit({ actorId: userId, action: "decoration.submit", detail: d.id });
    return d;
  }

  /** The creator takes back one of theirs: a waiting or turned-down one is deleted, an approved one taken off everyone. */
  async withdraw(userId: string, id: string): Promise<void> {
    const d = await this.store.get(id);
    if (!d || d.creatorId !== userId) throw notFound("Not found");
    if (d.status === "approved") {
      await this.takeDown(d, userId, null);
    } else {
      await this.store.remove(id);
      await deleteBlobNow(this.ctx, "profile-photos", decorationBlob(id));
    }
    this.ctx.audit({ actorId: userId, action: "decoration.withdraw", detail: id });
  }

  /** An operator's decision on [id]; false when it isn't in a state that decision applies to. */
  async decide(id: string, decision: "approve" | "reject" | "remove", operatorId: string, reason: string | null): Promise<StoredDecoration | null> {
    const d = await this.store.get(id);
    if (!d) return null;
    if (decision === "remove") {
      if (d.status !== "approved") return null;
      await this.takeDown(d, operatorId, reason);
    } else {
      const status: DecorationStatus = decision === "approve" ? "approved" : "rejected";
      const changed = await this.store.review(id, ["pending"], { status, reviewedAt: now(), reviewedBy: operatorId, reason: decision === "reject" ? reason : null });
      if (!changed) return null;
      if (status === "approved") this.hold({ ...d, status });
    }
    return this.store.get(id);
  }

  /** Someone changed what they wear: the counts follow. A failure only leaves a count stale, so it's logged. */
  async worn(before: string | null, after: string | null): Promise<void> {
    if (before === after) return;
    const bump = async (id: string | null, by: number) => {
      if (!id?.startsWith("c_")) return;
      try {
        await this.store.addWearers(id, by);
      } catch (err) {
        this.ctx.log.warn({ err, id }, "decoration wearer count not updated");
      }
    };
    await bump(before, -1);
    await bump(after, 1);
  }

  /** The image of a decoration anyone may load; null when there's none. */
  async publicImage(id: string): Promise<{ type: string; body: NodeJS.ReadableStream | Buffer; immutable: boolean } | null> {
    if (BUILTIN_IDS.has(id)) {
      const file = path.join(builtinDir(), `${id}.webp`);
      return fs.existsSync(file) ? { type: "image/webp", body: fs.createReadStream(file), immutable: false } : null;
    }
    const d = this.approvedById.get(id);
    return d ? this.blob(d, true) : null;
  }

  /** The image of one of [userId]'s own submissions, whatever its status. */
  async ownImage(userId: string, id: string) {
    const d = await this.store.get(id);
    return d && d.creatorId === userId ? this.blob(d, false) : null;
  }

  /** The image of any submission, for the review queue. */
  async anyImage(id: string) {
    const d = await this.store.get(id);
    return d ? this.blob(d, false) : null;
  }

  private async blob(d: StoredDecoration, immutable: boolean) {
    const stream = await this.ctx.blobs.get("profile-photos", decorationBlob(d.id));
    return stream ? { type: MIME[d.format], body: stream, immutable } : null;
  }

  private pendingLimit(userId: string): number {
    return this.isArtist(userId) ? DECORATION_LIMITS.artistPending : DECORATION_LIMITS.pending;
  }

  private hold(d: StoredDecoration): void {
    if (this.approvedById.has(d.id)) return;
    this.approvedById.set(d.id, { ...d });
    this.approvedCount.set(d.creatorId, (this.approvedCount.get(d.creatorId) ?? 0) + 1);
  }

  private release(d: StoredDecoration): void {
    if (!this.approvedById.delete(d.id)) return;
    const left = (this.approvedCount.get(d.creatorId) ?? 1) - 1;
    if (left > 0) this.approvedCount.set(d.creatorId, left);
    else this.approvedCount.delete(d.creatorId);
  }

  /** Out of the catalog, and off everyone wearing it (they go back to no decoration and their contacts hear of it). */
  private async takeDown(d: StoredDecoration, by: string, reason: string | null): Promise<void> {
    await this.store.review(d.id, ["approved"], { status: "removed", reviewedAt: now(), reviewedBy: by, reason });
    this.release(d);
    const wearing = this.ctx.identity
      .all<{ id: string; profile_style: string | null }>("users", { where: { profile_style: { ne: null } } })
      .filter((u) => styleOf(u).decoration === d.id);
    for (const u of wearing) {
      await this.ctx.identity.write((w) => w.update("users", { id: u.id }, { profile_style: JSON.stringify({ ...styleOf(u), decoration: null }), updated_at: now() }));
      announceProfileChange(this.ctx, u.id);
    }
    await this.store.setWearers(d.id, 0);
  }
}
