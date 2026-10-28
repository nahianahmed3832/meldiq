import { AccessToken, RoomServiceClient, TrackType, WebhookReceiver, type WebhookEvent } from "livekit-server-sdk";
import type { Config } from "../../app/config.js";

/**
 * Thin wrapper around the official LiveKit server SDK. Tokens are short-lived (10 min) and
 * scoped to exactly one room. LiveKit refreshes tokens for already-connected participants.
 */
export class LiveKitService {
  private rooms: RoomServiceClient;
  private receiver: WebhookReceiver;

  constructor(private cfg: NonNullable<Config["livekit"]>) {
    this.rooms = new RoomServiceClient(cfg.apiUrl, cfg.apiKey, cfg.apiSecret);
    this.receiver = new WebhookReceiver(cfg.apiKey, cfg.apiSecret);
  }

  get publicUrl(): string {
    return this.cfg.publicUrl;
  }

  /** [canPublish] false: a listener (voice channels where the person may not speak), who can still receive and send data. */
  async token(p: { room: string; identity: string; name: string; metadata: string; canPublish?: boolean }): Promise<string> {
    const at = new AccessToken(this.cfg.apiKey, this.cfg.apiSecret, {
      identity: p.identity,
      name: p.name,
      metadata: p.metadata,
      ttl: "10m",
    });
    at.addGrant({
      room: p.room,
      roomJoin: true,
      canPublish: p.canPublish ?? true,
      canSubscribe: true,
      canPublishData: true,
      canUpdateOwnMetadata: false,
    });
    return at.toJwt();
  }

  async deleteRoom(room: string): Promise<void> {
    try {
      await this.rooms.deleteRoom(room);
    } catch {
      // Room may already be gone (empty-timeout) — that is fine.
    }
  }

  /** Distinct Griip user ids currently connected to a room, or null if LiveKit is unreachable. */
  async participantUsers(room: string): Promise<Set<string> | null> {
    const ids = await this.participantIdentities(room);
    return ids && new Set(ids.map((i) => i.split(".")[0]));
  }

  /** LiveKit identities (`<userId>.<deviceId>`) in a room; [] for a missing room, null if LiveKit is unreachable. */
  async participantIdentities(room: string): Promise<string[] | null> {
    try {
      const list = await withTimeout(this.rooms.listParticipants(room));
      return list.map((p) => p.identity);
    } catch (e) {
      return isNotFound(e) ? [] : null;
    }
  }

  /** "absent" when the participant or room is already gone; "error" when LiveKit could not be reached. */
  async removeParticipant(room: string, identity: string): Promise<"removed" | "absent" | "error"> {
    try {
      await withTimeout(this.rooms.removeParticipant(room, identity));
      return "removed";
    } catch (e) {
      return isNotFound(e) ? "absent" : "error";
    }
  }

  /**
   * Mutes every microphone track [identity] publishes (a voice-room moderator's "mute"). The media server stops
   * forwarding it; only the person can unmute themselves. "absent" when they aren't in the room.
   */
  async muteAudio(room: string, identity: string): Promise<"muted" | "absent" | "error"> {
    try {
      const p = await withTimeout(this.rooms.getParticipant(room, identity));
      for (const t of p.tracks) if (t.type === TrackType.AUDIO && !t.muted) await withTimeout(this.rooms.mutePublishedTrack(room, identity, t.sid, true));
      return "muted";
    } catch (e) {
      return isNotFound(e) ? "absent" : "error";
    }
  }

  /** Mutes one published track (a screen share above the person's plan, docs/MOJO.md). */
  async muteTrack(room: string, identity: string, trackSid: string): Promise<"muted" | "absent" | "error"> {
    try {
      await withTimeout(this.rooms.mutePublishedTrack(room, identity, trackSid, true));
      return "muted";
    } catch (e) {
      return isNotFound(e) ? "absent" : "error";
    }
  }

  async receiveWebhook(body: string, auth: string | undefined): Promise<WebhookEvent> {
    return this.receiver.receive(body, auth);
  }
}

/** A room or participant that doesn't exist (never created, already closed or already left). */
function isNotFound(e: unknown): boolean {
  const err = e as { status?: number; code?: string; message?: string };
  const msg = String(err?.message ?? e).toLowerCase();
  return err?.status === 404 || err?.code === "not_found" || msg.includes("not found") || msg.includes("does not exist");
}

/** Bounds a LiveKit API call so an unreachable media server can't stall a request or the cleanup job. */
function withTimeout<T>(p: Promise<T>, ms = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("LiveKit request timed out")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
