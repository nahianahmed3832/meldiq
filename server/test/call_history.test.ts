import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";
import { backdateCall } from "./support/calls.js";

/**
 * Call history (2026-10-17): ended calls say who connected and for how long, and a member can list a conversation's
 * calls since they joined it. The times come from the server's own connection records; nothing is invented.
 */
let h: Harness;
let alice: GriipClient, bob: GriipClient, carol: GriipClient, dave: GriipClient, eve: GriipClient;
let dmId: string, groupId: string;

/** Moves a call's recorded times into the past (seconds before now), so durations are measurable without waiting. */
async function backdate(callId: string, seconds: number) {
  const ms = seconds * 1000;
  await backdateCall(h.ctx, callId, ms);
  // ...and the memberships with them, so the call still happened after everyone joined the conversation.
  const conversationId = (await h.ctx.calls.get(callId))!.conversation_id;
  await h.ctx.ws.write((w) => {
    for (const m of w.all<{ user_id: string; joined_at: number }>("conversation_members", { where: { conversation_id: conversationId } })) {
      w.update("conversation_members", { conversation_id: conversationId, user_id: m.user_id }, { joined_at: m.joined_at - ms });
    }
  });
}

beforeAll(async () => {
  h = await startServer();
  alice = await h.client("alice");
  bob = await h.client("bob");
  carol = await h.client("carol");
  dave = await h.client("dave");
  eve = await h.client("eve");
  dmId = (await alice.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
  groupId = (await alice.req("POST", "/v1/conversations/group", { name: "Crew", memberIds: [bob.userId, carol.userId] })).conversation.id;
  await alice.connect();
});
afterAll(async () => h.close());

describe("call history", () => {
  it("a completed 1:1 call reports both people and their connected time", async () => {
    const r = await alice.req("POST", "/v1/calls", { conversationId: dmId, video: false });
    await alice.req("POST", `/v1/calls/${r.call.id}/connected`);
    const live = await bob.req("POST", `/v1/calls/${r.call.id}/connected`);
    expect(live.call.state).toBe("ACTIVE");
    expect(live.call.attended).toBeUndefined(); // only for ended calls
    await backdate(r.call.id, 65);
    await bob.req("POST", `/v1/calls/${r.call.id}/end`);
    const ended = await alice.waitFor(() => alice.events.find((e) => e.t === "call" && e.event === "ended" && e.call.id === r.call.id));
    expect(ended.call.endReason).toBe("hangup");
    expect(ended.call.answeredAt).toBeGreaterThan(0);
    const people = Object.fromEntries(ended.call.attended.map((a: any) => [a.userId, a.seconds]));
    expect(Object.keys(people).sort()).toEqual([alice.userId, bob.userId].sort());
    expect(people[alice.userId]).toBeGreaterThanOrEqual(64);
    expect(people[alice.userId]).toBeLessThan(70);
  });

  it("an unanswered call has no attendance from the person who only rang", async () => {
    const r = await alice.req("POST", "/v1/calls", { conversationId: dmId, video: true });
    await alice.req("POST", `/v1/calls/${r.call.id}/connected`);
    await bob.req("POST", `/v1/calls/${r.call.id}/alerted`);
    const declined = await bob.req("POST", `/v1/calls/${r.call.id}/decline`);
    expect(declined.call.endReason).toBe("declined");
    expect(declined.call.answeredAt).toBeNull();
    expect(declined.call.attended.map((a: any) => a.userId)).toEqual([alice.userId]);
  });

  it("group calls list everyone who connected, once each, even across two devices", async () => {
    const r = await alice.req("POST", "/v1/calls", { conversationId: groupId, video: true });
    await alice.req("POST", `/v1/calls/${r.call.id}/connected`);
    await bob.req("POST", `/v1/calls/${r.call.id}/connected`);
    // bob reconnects from a second device while still connected: one entry for him, overlapping time counted once.
    await h.ctx.calls.join(r.call.id, bob.userId, "bob-tablet", Date.now(), true);
    await backdate(r.call.id, 30);
    await bob.req("POST", `/v1/calls/${r.call.id}/leave`);
    await alice.req("POST", `/v1/calls/${r.call.id}/leave`);
    // The tablet left last: the call ends once nobody is connected.
    await h.ctx.calls.leave(r.call.id, "bob-tablet", Date.now());
    const row = (await h.ctx.calls.get(r.call.id))!;
    const { endCallRow } = await import("../src/modules/calls/routes.js");
    await endCallRow(h.ctx, row, "empty");
    const call = (await carol.req("GET", `/v1/calls/${r.call.id}`)).call;
    expect(call.state).toBe("ENDED");
    expect(call.endReason).toBe("empty");
    const ids = call.attended.map((a: any) => a.userId);
    expect(ids.sort()).toEqual([alice.userId, bob.userId].sort()); // carol never connected: she missed it
    for (const a of call.attended) expect(a.seconds).toBeGreaterThanOrEqual(29);
    const bobs = call.attended.find((a: any) => a.userId === bob.userId);
    expect(bobs.seconds).toBeLessThan(40); // the two devices overlapped: not 60
  });

  it("members list a conversation's calls newest first, only since they joined", async () => {
    const list = (await bob.req("GET", `/v1/conversations/${dmId}/calls`)).calls;
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0].createdAt).toBeGreaterThanOrEqual(list[1].createdAt);
    expect(list.every((c: any) => c.conversationId === dmId)).toBe(true);
    const page = (await bob.req("GET", `/v1/conversations/${dmId}/calls?limit=1`)).calls;
    expect(page).toHaveLength(1);
    const older = (await bob.req("GET", `/v1/conversations/${dmId}/calls?before=${page[0].createdAt}`)).calls;
    expect(older.every((c: any) => c.createdAt < page[0].createdAt)).toBe(true);
    await expectStatus(eve.req("GET", `/v1/conversations/${dmId}/calls`), 404);
    await expectStatus(bob.req("GET", `/v1/conversations/${dmId}/calls?limit=1000`), 400);

    // dave joins the group after its call: he doesn't see calls from before he was a member.
    await alice.req("PUT", `/v1/conversations/${groupId}/members/${dave.userId}`, {});
    expect((await dave.req("GET", `/v1/conversations/${groupId}/calls`)).calls).toEqual([]);
    expect((await carol.req("GET", `/v1/conversations/${groupId}/calls`)).calls).toHaveLength(1);
  });
});
