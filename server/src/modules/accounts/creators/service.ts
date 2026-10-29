import type { z } from "zod/v4";
import type { AppContext } from "../../../app/context.js";
import { type DocumentStore, DuplicateDocument, openDocuments } from "../../../infrastructure/database/documents.js";
import { CREATOR_PLATFORMS, CREATOR_RULES, type CreatorPostBody, type CreatorVerificationQuery } from "../../../shared/contracts/http/creators.js";
import { ApiError, badRequest, conflict } from "../../../shared/errors.js";
import { newId, now } from "../../../shared/utilities/util.js";
import { deleteBlobNow } from "../../files/index.js";
import { storePhoto } from "../photos.js";
import { announceProfileChange } from "../profileEvents.js";
import { approvalHolds, codeLineFor, MAX_UNCOUNTED_POSTS, PROOF_TYPES, proofType, type ProofType, sameName } from "./rules.js";

type Platform = (typeof CREATOR_PLATFORMS)[number];
type Status = "pending" | "approved" | "rejected";

/** A channel verification application. Its proof screenshot is the profile-photos blob proofBlob(id). */
export interface Verification {
  id: string;
  userId: string;
  platform: Platform;
  channelName: string;
  link: string;
  notes: string | null;
  status: Status;
  reason: string | null;
  proofType: ProofType;
  proofSize: number;
  createdAt: number;
  reviewedAt: number | null;
  /** The operator's console account id. */
  reviewedBy: string | null;
  /** The username when it was approved (the badge survives display name changes, not a username that stops matching). */
  usernameAtApproval: string | null;
}

/** An application to the creator programme. */
export interface ProgramApplication {
  id: string;
  userId: string;
  status: Status;
  reason: string | null;
  createdAt: number;
  reviewedAt: number | null;
  reviewedBy: string | null;
}

/** A link a programme member sent. */
export interface CreatorPostDoc {
  id: string;
  userId: string;
  url: string;
  platform: Platform;
  views: number | null;
  counted: boolean;
  rewardNote: string | null;
  createdAt: number;
  reviewedAt: number | null;
  reviewedBy: string | null;
}

export interface CreatorStores {
  verifications: DocumentStore<Verification>;
  program: DocumentStore<ProgramApplication>;
  posts: DocumentStore<CreatorPostDoc>;
}

export interface Page<T> {
  items: T[];
  next: number | null;
}

/** The blob of a proof screenshot (in the profile-photos store, never served publicly). */
export const proofBlob = (id: string) => `creator-proof-${id}`;

const pendingPerUser = [{ name: "user_pending", keys: { user_id: 1 } as Record<string, 1>, unique: true, partial: { status: "pending" } }];

/** Opens the stores: MongoDB whenever the server has one (creator_verifications, creator_program, creator_posts), memory otherwise. */
export async function openCreatorStores(ctx: Pick<AppContext, "mongo">): Promise<CreatorStores> {
  return {
    verifications: await openDocuments<Verification>(ctx.mongo, "creator_verifications", [...pendingPerUser, { name: "status_created", keys: { status: 1, created_at: -1 } }]),
    program: await openDocuments<ProgramApplication>(ctx.mongo, "creator_program", [...pendingPerUser, { name: "status_created", keys: { status: 1, created_at: -1 } }]),
    posts: await openDocuments<CreatorPostDoc>(ctx.mongo, "creator_posts", [
      { name: "user_url", keys: { user_id: 1, url: 1 }, unique: true },
      { name: "counted_created", keys: { counted: 1, created_at: -1 } },
    ]),
  };
}

interface UserNames {
  username: string | null;
  display_name: string;
}

async function pageOf<T extends { id: string; createdAt: number }>(store: DocumentStore<T>, match: Partial<T>, before: number | null, limit: number): Promise<Page<T>> {
  const rows = await store.find(match, { newestBy: "createdAt", before: before ?? undefined, limit: limit + 1 });
  const items = rows.slice(0, limit);
  return { items, next: rows.length > limit ? items[items.length - 1]!.createdAt : null };
}

/**
 * Creator verification and the creator programme (API 0.65.0 batch B, docs/SETTINGS_PARITY_API.md). The request path
 * reads an in-memory copy of the approved verifications (badges are worked out synchronously while profiles are
 * built); every change is written to the store first.
 */
export class CreatorService {
  private readonly approved = new Map<string, { id: string; channelName: string; usernameAtApproval: string | null }[]>();
  /** People whose application is being stored right now (the memory store has no unique index). */
  private readonly applying = new Set<string>();

  constructor(
    private readonly ctx: AppContext,
    readonly stores: CreatorStores,
  ) {}

  async load(): Promise<void> {
    for (const v of await this.stores.verifications.find({ status: "approved" })) this.hold(v);
  }

  private user(userId: string): UserNames | null {
    return this.ctx.identity.get<UserNames>("users", { id: userId }) ?? null;
  }

  /** The Creator badge: an approved channel that still holds for the person's current username (rules.ts approvalHolds). */
  isVerified(userId: string): boolean {
    const held = this.approved.get(userId);
    if (!held?.length) return false;
    const username = this.user(userId)?.username ?? null;
    return held.some((a) => approvalHolds(a, username));
  }

  /** Whether [channelName] matches [userId]'s username or display name now. */
  nameMatches(userId: string, channelName: string): boolean {
    const u = this.user(userId);
    return !!u && (sameName(channelName, u.username) || sameName(channelName, u.display_name));
  }

  usernameOf(userId: string): string | null {
    return this.user(userId)?.username ?? null;
  }

  codeLine(userId: string): string | null {
    return codeLineFor(this.user(userId)?.username);
  }

  applicationView(v: Verification) {
    return { id: v.id, platform: v.platform, channelName: v.channelName, link: v.link, notes: v.notes, status: v.status, reason: v.reason, createdAt: v.createdAt, reviewedAt: v.reviewedAt };
  }

  programView(a: ProgramApplication) {
    return { id: a.id, status: a.status, reason: a.reason, createdAt: a.createdAt, reviewedAt: a.reviewedAt };
  }

  postView(p: CreatorPostDoc) {
    return { id: p.id, url: p.url, platform: p.platform, views: p.views, counted: p.counted, rewardNote: p.rewardNote, createdAt: p.createdAt, reviewedAt: p.reviewedAt };
  }

  async verification(userId: string) {
    const applications = await this.stores.verifications.find({ userId }, { newestBy: "createdAt" });
    return {
      codeLine: this.codeLine(userId),
      rules: {
        minFollowers: CREATOR_RULES.minFollowers,
        nameMatches: ["username" as const, "displayName" as const],
        platforms: [...CREATOR_PLATFORMS],
        notesMax: CREATOR_RULES.notesMax,
        proofMaxBytes: CREATOR_RULES.proofMaxBytes,
        proofTypes: Object.values(PROOF_TYPES),
      },
      verified: this.isVerified(userId),
      applications: applications.map((v) => this.applicationView(v)),
    };
  }

  /** Stores [userId]'s application with its proof screenshot [buf], waiting for review. */
  async apply(userId: string, form: z.infer<typeof CreatorVerificationQuery>, buf: Buffer): Promise<Verification> {
    if (!this.codeLine(userId)) throw badRequest("Pick a username first: the code line in your bio carries it.");
    if (!this.nameMatches(userId, form.channelName)) {
      throw new ApiError(400, "creator_name_mismatch", "The channel's name has to match your username or display name.");
    }
    const type = proofType(buf);
    if (!type) throw badRequest("The proof is a PNG, JPEG or WebP screenshot.");
    if (this.applying.has(userId)) throw new ApiError(409, "application_open", "You already have an application waiting for review.");
    this.applying.add(userId);
    try {
      if ((await this.stores.verifications.count({ userId, status: "pending" })) > 0) {
        throw new ApiError(409, "application_open", "You already have an application waiting for review.");
      }
      const v: Verification = {
        id: newId("crv"),
        userId,
        platform: form.platform,
        channelName: form.channelName,
        link: form.link,
        notes: form.notes || null,
        status: "pending",
        reason: null,
        proofType: type,
        proofSize: buf.length,
        createdAt: now(),
        reviewedAt: null,
        reviewedBy: null,
        usernameAtApproval: null,
      };
      await storePhoto(this.ctx, proofBlob(v.id), buf);
      try {
        await this.stores.verifications.insert(v);
      } catch (e) {
        await deleteBlobNow(this.ctx, "profile-photos", proofBlob(v.id));
        if (e instanceof DuplicateDocument) throw new ApiError(409, "application_open", "You already have an application waiting for review.");
        throw e;
      }
      this.ctx.audit({ actorId: userId, action: "creator.verification.apply", detail: v.id });
      return v;
    } finally {
      this.applying.delete(userId);
    }
  }

  verificationPage(status: Status, before: number | null, limit: number): Promise<Page<Verification>> {
    return pageOf(this.stores.verifications, { status }, before, limit);
  }

  /** An operator's decision on a pending application; null when it isn't pending (or doesn't exist). */
  async decideVerification(id: string, decision: "approve" | "reject", operatorId: string, reason: string | null): Promise<Verification | null> {
    const v = await this.stores.verifications.get(id);
    if (!v) return null;
    const at = now();
    const approve = decision === "approve";
    const decided = await this.stores.verifications.update(
      id,
      { status: "pending" },
      { status: approve ? "approved" : "rejected", reviewedAt: at, reviewedBy: operatorId, reason: approve ? null : reason, usernameAtApproval: approve ? (this.user(v.userId)?.username ?? null) : null },
    );
    if (decided && approve) {
      this.hold(decided);
      announceProfileChange(this.ctx, decided.userId);
    }
    return decided;
  }

  /** The proof screenshot of any application, for the review queue. */
  async proof(id: string): Promise<{ type: string; body: NodeJS.ReadableStream } | null> {
    const v = await this.stores.verifications.get(id);
    if (!v) return null;
    const body = await this.ctx.blobs.get("profile-photos", proofBlob(id));
    return body ? { type: v.proofType, body } : null;
  }

  async latestProgram(userId: string): Promise<ProgramApplication | null> {
    return (await this.stores.program.find({ userId }, { newestBy: "createdAt", limit: 1 }))[0] ?? null;
  }

  async program(userId: string) {
    const application = await this.latestProgram(userId);
    return {
      steps: { verified: this.isVerified(userId), applied: application !== null, approved: application?.status === "approved" },
      application: application ? this.programView(application) : null,
      posts: (await this.posts(userId)).map((p) => this.postView(p)),
    };
  }

  async applyProgram(userId: string): Promise<ProgramApplication> {
    if (!this.isVerified(userId)) throw new ApiError(403, "not_verified_creator", "Verify your channel first: the creator programme is for verified creators.");
    const latest = await this.latestProgram(userId);
    if (latest?.status === "pending") throw new ApiError(409, "application_open", "Your application to the creator programme is waiting for review.");
    if (latest?.status === "approved") throw conflict("You're in the creator programme already.");
    const a: ProgramApplication = { id: newId("crp"), userId, status: "pending", reason: null, createdAt: now(), reviewedAt: null, reviewedBy: null };
    try {
      await this.stores.program.insert(a);
    } catch (e) {
      if (e instanceof DuplicateDocument) throw new ApiError(409, "application_open", "Your application to the creator programme is waiting for review.");
      throw e;
    }
    this.ctx.audit({ actorId: userId, action: "creator.program.apply", detail: a.id });
    return a;
  }

  programPage(status: Status, before: number | null, limit: number): Promise<Page<ProgramApplication>> {
    return pageOf(this.stores.program, { status }, before, limit);
  }

  decideProgram(id: string, decision: "approve" | "reject", operatorId: string, reason: string | null): Promise<ProgramApplication | null> {
    const approve = decision === "approve";
    return this.stores.program.update(id, { status: "pending" }, { status: approve ? "approved" : "rejected", reviewedAt: now(), reviewedBy: operatorId, reason: approve ? null : reason });
  }

  posts(userId: string): Promise<CreatorPostDoc[]> {
    return this.stores.posts.find({ userId }, { newestBy: "createdAt" });
  }

  async submitPost(userId: string, body: z.infer<typeof CreatorPostBody>): Promise<CreatorPostDoc> {
    const member = (await this.latestProgram(userId))?.status === "approved";
    if (!member || !this.isVerified(userId)) {
      throw new ApiError(403, "not_in_creator_program", "Posts are for approved members of the creator programme who are still verified.");
    }
    if ((await this.stores.posts.count({ userId, counted: false })) >= MAX_UNCOUNTED_POSTS) {
      throw new ApiError(409, "limit_reached", `You have ${MAX_UNCOUNTED_POSTS} posts waiting to be counted. Wait until they're reviewed.`);
    }
    if ((await this.stores.posts.count({ userId, url: body.url })) > 0) throw conflict("You sent that link already.");
    const p: CreatorPostDoc = { id: newId("crs"), userId, url: body.url, platform: body.platform, views: body.views ?? null, counted: false, rewardNote: null, createdAt: now(), reviewedAt: null, reviewedBy: null };
    try {
      await this.stores.posts.insert(p);
    } catch (e) {
      if (e instanceof DuplicateDocument) throw conflict("You sent that link already.");
      throw e;
    }
    return p;
  }

  postsPage(counted: boolean, before: number | null, limit: number): Promise<Page<CreatorPostDoc>> {
    return pageOf(this.stores.posts, { counted }, before, limit);
  }

  /** An operator marks a post counted (or not) and may note its reward; [rewardNote] undefined keeps the note. */
  reviewPost(id: string, operatorId: string, counted: boolean, rewardNote: string | null | undefined): Promise<CreatorPostDoc | null> {
    return this.stores.posts.update(id, {}, { counted, reviewedAt: now(), reviewedBy: operatorId, ...(rewardNote !== undefined ? { rewardNote: rewardNote || null } : {}) });
  }

  /** Account deletion: applications, proofs, programme applications and posts. */
  async deleteForUser(userId: string): Promise<void> {
    const mine = await this.stores.verifications.find({ userId });
    for (const v of mine) await deleteBlobNow(this.ctx, "profile-photos", proofBlob(v.id));
    await this.stores.verifications.deleteMany({ userId });
    await this.stores.program.deleteMany({ userId });
    await this.stores.posts.deleteMany({ userId });
    this.approved.delete(userId);
  }

  private hold(v: Verification): void {
    const list = this.approved.get(v.userId) ?? [];
    if (list.some((a) => a.id === v.id)) return;
    this.approved.set(v.userId, [...list, { id: v.id, channelName: v.channelName, usernameAtApproval: v.usernameAtApproval }]);
  }
}
