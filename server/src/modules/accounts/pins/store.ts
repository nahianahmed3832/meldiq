/** A community's pin. Its image is the blob pinBlob(id) in profile-photos. */
export interface StoredPin {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  format: "png" | "webp" | "gif";
  animated: boolean;
  createdBy: string;
  createdAt: number;
}

/** A pin given to someone. */
export interface StoredAward {
  pinId: string;
  orgId: string;
  userId: string;
  awardedBy: string;
  awardedAt: number;
}

/**
 * Where community pins are kept (docs/PROFILE_PINS.md): MongoDB whenever the server has one (`community_pins` and
 * `community_pin_awards`: new data goes to MongoDB), otherwise this process's memory (development and tests without
 * MONGODB_URI). PinService keeps an in-memory copy of everything for the request path (profiles are built synchronously).
 */
export interface PinStore {
  readonly backend: "memory" | "mongodb" | "postgres";
  pins(): Promise<StoredPin[]>;
  awards(): Promise<StoredAward[]>;
  insertPin(p: StoredPin): Promise<void>;
  /** Deletes the pin and everyone's award of it. */
  removePin(id: string): Promise<void>;
  /** Gives [a]; giving it again changes nothing. Whether it was new. */
  award(a: StoredAward): Promise<boolean>;
  revoke(pinId: string, userId: string): Promise<boolean>;
}

const awardKey = (pinId: string, userId: string) => `${pinId}:${userId}`;

export class MemoryPinStore implements PinStore {
  readonly backend = "memory" as const;
  private readonly pinRows = new Map<string, StoredPin>();
  private readonly awardRows = new Map<string, StoredAward>();

  async pins(): Promise<StoredPin[]> {
    return [...this.pinRows.values()].map((p) => ({ ...p }));
  }

  async awards(): Promise<StoredAward[]> {
    return [...this.awardRows.values()].map((a) => ({ ...a }));
  }

  async insertPin(p: StoredPin): Promise<void> {
    if (this.pinRows.has(p.id)) throw new Error(`pin ${p.id} exists`);
    this.pinRows.set(p.id, { ...p });
  }

  async removePin(id: string): Promise<void> {
    this.pinRows.delete(id);
    for (const [k, a] of this.awardRows) if (a.pinId === id) this.awardRows.delete(k);
  }

  async award(a: StoredAward): Promise<boolean> {
    const k = awardKey(a.pinId, a.userId);
    if (this.awardRows.has(k)) return false;
    this.awardRows.set(k, { ...a });
    return true;
  }

  async revoke(pinId: string, userId: string): Promise<boolean> {
    return this.awardRows.delete(awardKey(pinId, userId));
  }
}
