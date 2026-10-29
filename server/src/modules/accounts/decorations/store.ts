import type { DecorationStatus } from "../../../shared/contracts/http/decorations.js";

/** A decoration someone sent in, at any stage of review. Its image is the blob decorationBlob(id) in profile-photos. */
export interface StoredDecoration {
  id: string;
  creatorId: string;
  name: string;
  status: DecorationStatus;
  /** The image's format, as recognised by its bytes. */
  format: "png" | "webp" | "gif";
  animated: boolean;
  size: number;
  createdAt: number;
  reviewedAt: number | null;
  /** The operator's account id for a review; the creator's own user id when they withdrew it. */
  reviewedBy: string | null;
  reason: string | null;
  /** How many people wear it (kept as people put it on and take it off). */
  wearers: number;
}

export interface DecorationPage {
  items: StoredDecoration[];
  /** Pass back as [before] for the next, older page; null on the last. */
  next: number | null;
}

/**
 * Where submitted decorations are kept (docs/PROFILE_DECORATIONS.md): MongoDB whenever the server has one
 * (`profile_decorations`: new data goes to MongoDB), otherwise this process's memory (development and tests without
 * MONGODB_URI). DecorationService keeps an in-memory copy of the approved ones for the request path.
 */
export interface DecorationStore {
  readonly backend: "memory" | "mongodb";
  insert(d: StoredDecoration): Promise<void>;
  get(id: string): Promise<StoredDecoration | null>;
  /** Every approved decoration (loaded at start). */
  approved(): Promise<StoredDecoration[]>;
  byCreator(creatorId: string): Promise<StoredDecoration[]>;
  countPending(creatorId: string): Promise<number>;
  /** A page of one status, newest first, created before [before]. */
  page(status: DecorationStatus, before: number | null, limit: number): Promise<DecorationPage>;
  /** Sets the review of [id] if it's still in one of [from]; whether it changed. */
  review(id: string, from: readonly DecorationStatus[], change: Pick<StoredDecoration, "status" | "reviewedAt" | "reviewedBy" | "reason">): Promise<boolean>;
  remove(id: string): Promise<void>;
  /** Adds [by] to the wearer count (never below zero). */
  addWearers(id: string, by: number): Promise<void>;
  setWearers(id: string, count: number): Promise<void>;
}

export class MemoryDecorationStore implements DecorationStore {
  readonly backend = "memory" as const;
  private readonly rows = new Map<string, StoredDecoration>();

  async insert(d: StoredDecoration): Promise<void> {
    if (this.rows.has(d.id)) throw new Error(`decoration ${d.id} exists`);
    this.rows.set(d.id, { ...d });
  }

  async get(id: string): Promise<StoredDecoration | null> {
    const d = this.rows.get(id);
    return d ? { ...d } : null;
  }

  async approved(): Promise<StoredDecoration[]> {
    return this.all().filter((d) => d.status === "approved");
  }

  async byCreator(creatorId: string): Promise<StoredDecoration[]> {
    return this.all().filter((d) => d.creatorId === creatorId);
  }

  async countPending(creatorId: string): Promise<number> {
    return this.all().filter((d) => d.creatorId === creatorId && d.status === "pending").length;
  }

  async page(status: DecorationStatus, before: number | null, limit: number): Promise<DecorationPage> {
    const all = this.all().filter((d) => d.status === status && (before == null || d.createdAt < before));
    const items = all.slice(0, limit);
    return { items, next: all.length > limit ? items[items.length - 1].createdAt : null };
  }

  async review(id: string, from: readonly DecorationStatus[], change: Pick<StoredDecoration, "status" | "reviewedAt" | "reviewedBy" | "reason">): Promise<boolean> {
    const d = this.rows.get(id);
    if (!d || !from.includes(d.status)) return false;
    this.rows.set(id, { ...d, ...change });
    return true;
  }

  async remove(id: string): Promise<void> {
    this.rows.delete(id);
  }

  async addWearers(id: string, by: number): Promise<void> {
    const d = this.rows.get(id);
    if (d) this.rows.set(id, { ...d, wearers: Math.max(0, d.wearers + by) });
  }

  async setWearers(id: string, count: number): Promise<void> {
    const d = this.rows.get(id);
    if (d) this.rows.set(id, { ...d, wearers: count });
  }

  /** Newest first. */
  private all(): StoredDecoration[] {
    return [...this.rows.values()].map((d) => ({ ...d })).sort((a, b) => b.createdAt - a.createdAt);
  }
}
