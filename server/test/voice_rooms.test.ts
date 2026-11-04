import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LiveKitService } from "../src/modules/calls/livekit.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/** A stand-in media server: who is in which room, and which microphones were muted by a moderator. */
class FakeLiveKit {
  publicUrl = "ws://livekit.test";
  rooms = new Map<string, Set<string>>();
  muted: string[] = [];
  async token(p: { identity: string }) {
    return `token:${p.identity}`;
  }
  async deleteRoom(room: string) {
    this.rooms.delete(room);
  }
  async participantIdentities(room: string) {
    return [...(this.rooms.get(room) ?? [])];
  }
  async participantUsers(room: string) {
    return new Set(
      [...(this.rooms.get(room) ?? [])].map((i) => i.split(".")[0]),
    );
  }
  async removeParticipant(room: string, identity: string) {
    return this.rooms.get(room)?.delete(identity)
      ? ("removed" as const)
      : ("absent" as const);
  }
  async muteAudio(room: string, identity: string) {
    if (!this.rooms.get(room)?.has(identity)) return "absent" as const;
    this.muted.push(identity);
    return "muted" as const;
  }
  join(room: string, c: GriipClient) {
    if (!this.rooms.has(room)) this.rooms.set(room, new Set());
    this.rooms.get(room)!.add(`${c.userId}.${c.deviceId}`);
  }
}

let h: Harness;
let lk: FakeLiveKit;
let owner: GriipClient, member: GriipClient, other: GriipClient;
let orgId: string, roomId: string;

beforeAll(async () => {
  h = await startServer();
  lk = new FakeLiveKit();
  h.ctx.livekit = lk as unknown as LiveKitService;
  [owner, member, other] = await Promise.all(
    ["vrowner", "vrmember", "vrother"].map((n) => h.client(n)),
  );
  orgId = (await owner.req("POST", "/v1/orgs", { name: "Voice Lab" })).org.id;
  for (const c of [member, other]) {
    const code = (
      await owner.req("POST", `/v1/orgs/${orgId}/invites`, { role: "MEMBER" })
    ).invite.code;
    await c.req("POST", "/v1/invites/accept", { code });
  }
  roomId = (
    await owner.req("POST", `/v1/orgs/${orgId}/channels`, {
      name: "Lounge",
      scope: "ORG",
      voice: true,
      autoJoin: true,
    })
  ).channel.id;
  await Promise.all([owner, member, other].map((c) => c.connect()));
});
afterAll(async () => {
  await Promise.all([owner, member, other].map((c) => c.disconnect()));
  await h.close();
});

async function enter(c: GriipClient): Promise<{ id: string; room: string }> {
  const r = await c.req("POST", "/v1/calls", {
    conversationId: roomId,
    video: false,
  });
  lk.join(r.media.room, c);
  await c.req("POST", `/v1/calls/${r.call.id}/connected`);
  return { id: r.call.id, room: r.media.room };
}

describe("text channels (round 7)", () => {
  it("refuses to start a call in a text channel, while DMs still ring", async () => {
    const text = (
      await owner.req("POST", `/v1/orgs/${orgId}/channels`, {
        name: "general-text",
        scope: "ORG",
        kind: "PUBLIC",
        autoJoin: true,
      })
    ).channel.id;
    await expectStatus(
      member.req("POST", "/v1/calls", { conversationId: text, video: false }),
      409,
    );
    await expectStatus(
      member.req("POST", "/v1/calls", { conversationId: text, video: true }),
      409,
    );
    const dm = (
      await member.req("POST", "/v1/conversations/dm", { userId: other.userId })
    ).conversation.id;
    const r = await member.req("POST", "/v1/calls", {
      conversationId: dm,
      video: false,
    });
    expect(r.call.state).toBe("RINGING");
    await member.req("POST", `/v1/calls/${r.call.id}/end`);
  });
});

describe("voice rooms", () => {
  it("advertises the feature and creates a voice channel", async () => {
    expect((await owner.req("GET", "/v1/server-info")).features).toContain(
      "voice-rooms",
    );
    const conv = (await member.req("GET", `/v1/conversations/${roomId}`))
      .conversation;
    expect(conv).toMatchObject({ voice: true, type: "CHANNEL" });
    await expectStatus(
      owner.req("POST", `/v1/orgs/${orgId}/channels`, {
        name: "news",
        scope: "ORG",
        voice: true,
        kind: "ANNOUNCEMENT",
      }),
      400,
    );
  });

  it("opens without ringing anyone, is active at once, and the next person joins the same call", async () => {
    const before = member.events.length;
    const first = await enter(owner);
    const call = (await owner.req("GET", `/v1/calls/${first.id}`)).call;
    expect(call).toMatchObject({ state: "ACTIVE", voiceRoom: true, hands: [] });
    await member.waitFor(() =>
      member.events
        .slice(before)
        .find(
          (e) =>
            e.t === "call" && e.event === "started" && e.call.id === first.id,
        ),
    );
    expect(
      member.events
        .slice(before)
        .some((e) => e.t === "call" && e.event === "ring"),
    ).toBe(false);
    // Who is in the room shows on the conversation before joining.
    expect(
      (await other.req("GET", `/v1/conversations/${roomId}`)).conversation
        .activeCall,
    ).toMatchObject({ id: first.id, participantIds: [owner.userId] });
    const second = await enter(member);
    expect(second.id).toBe(first.id);
  });

  it("queues raised hands, lowers them on request or when someone leaves", async () => {
    const { id } = await enter(member);
    const raised = await member.req("POST", `/v1/calls/${id}/hand`, {
      raised: true,
    });
    expect(raised.call.hands).toEqual([member.userId]);
    // A manager lowers it; a plain member can't moderate.
    await expectStatus(
      other.req("POST", `/v1/calls/${id}/moderate`, {
        userId: member.userId,
        action: "lower_hand",
      }),
      403,
    );
    const lowered = await owner.req("POST", `/v1/calls/${id}/moderate`, {
      userId: member.userId,
      action: "lower_hand",
    });
    expect(lowered.call.hands).toEqual([]);
    await member.req("POST", `/v1/calls/${id}/hand`, { raised: true });
    await member.req("POST", `/v1/calls/${id}/leave`);
    expect((await owner.req("GET", `/v1/calls/${id}`)).call.hands).toEqual([]);
  });

  it("lets a manager mute someone's microphone and remove them from the call", async () => {
    const { id } = await enter(member);
    await owner.req("POST", `/v1/calls/${id}/moderate`, {
      userId: member.userId,
      action: "mute",
    });
    expect(lk.muted).toContain(`${member.userId}.${member.deviceId}`);
    await member.waitFor(() =>
      member.events.find(
        (e) => e.t === "call" && e.event === "moderated" && e.action === "mute",
      ),
    );
    await owner.req("POST", `/v1/calls/${id}/moderate`, {
      userId: member.userId,
      action: "remove",
    });
    await member.waitFor(() =>
      member.events.find(
        (e) =>
          e.t === "call" &&
          e.event === "ended" &&
          e.call.endReason === "removed",
      ),
    );
    const call = (await owner.req("GET", `/v1/calls/${id}`)).call;
    expect(call.participants.map((p: { userId: string }) => p.userId)).toEqual([
      owner.userId,
    ]);
    // Not in the call any more: nothing to mute.
    await expectStatus(
      owner.req("POST", `/v1/calls/${id}/moderate`, {
        userId: member.userId,
        action: "mute",
      }),
      404,
    );
  });

  it("closes when the last person leaves, and refuses hands outside voice rooms", async () => {
    const { id } = await enter(owner);
    await owner.req("POST", `/v1/calls/${id}/leave`);
    expect((await owner.req("GET", `/v1/calls/${id}`)).call.state).toBe(
      "ENDED",
    );
    const dm = (
      await owner.req("POST", "/v1/conversations/dm", { userId: member.userId })
    ).conversation.id;
    const call = await owner.req("POST", "/v1/calls", {
      conversationId: dm,
      video: false,
    });
    expect(call.call.voiceRoom).toBe(false);
    await expectStatus(
      owner.req("POST", `/v1/calls/${call.call.id}/hand`, { raised: true }),
      400,
    );
  });
});

describe("messages in voice channels (batch B14)", () => {
  it("allows the approved associated text chat while call controls keep independent voice permission", async () => {
    owner.serverMessages = member.serverMessages = true;
    await owner.send(
      roomId,
      { type: "text", text: "Associated text" },
      "message",
    );
    expect(
      (
        await member.req("GET", `/v2/conversations/${roomId}/messages`)
      ).messages.some((m: any) => m.payload.text === "Associated text"),
    ).toBe(true);
    await owner.req("PUT", `/v1/conversations/${roomId}/overwrites`, {
      subject: `user:${member.userId}`,
      allow: [],
      deny: ["messages.post"],
    });
    await expectStatus(
      member.send(roomId, { type: "text", text: "Denied text" }),
      403,
    );
    await member.send(
      roomId,
      { type: "call_key_request", callId: "x" },
      "control",
    );
    await owner.req("PUT", `/v1/conversations/${roomId}/overwrites`, {
      subject: `user:${member.userId}`,
      allow: [],
      deny: ["voice.connect"],
    });
    await expectStatus(
      member.send(roomId, { type: "call_key_request", callId: "x" }, "control"),
      403,
    );
    await member.send(roomId, { type: "text", text: "Text without voice" });
  });
});
