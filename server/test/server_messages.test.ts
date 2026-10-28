import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

const mid = () => crypto.randomBytes(12).toString("base64url");
const send = (c: GriipClient, conversationId: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  c.req("POST", "/v2/messages", { conversationId, messageId: mid(), cls: "message", sentAt: Date.now(), payload, ...extra });
const change = (c: GriipClient, conversationId: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  c.req("POST", "/v2/messages", { conversationId, messageId: mid(), cls: "control", sentAt: Date.now(), payload, ...extra });

/** Messages stored and served by the server (API 0.57.0, docs/SERVER_MESSAGES.md). */
describe("server-stored messages", () => {
  let h: Harness;
  let alice: GriipClient, bob: GriipClient, carol: GriipClient;
  let dm: string;
  beforeAll(async () => {
    h = await startServer({ MESSAGES_ACCEPT_ENCRYPTED: "false" });
    alice = await h.client("alice");
    bob = await h.client("bob");
    carol = await h.client("carol");
    dm = (await alice.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
  });
  afterAll(async () => h.close());

  it("stores a message, delivers it readable to the other members' devices, and serves it as history", async () => {
    const sent = await send(alice, dm, { type: "text", text: "hello bob" });
    expect(sent).toMatchObject({ duplicate: false });
    const queue = await bob.req("GET", "/v1/queue");
    const item = queue.items.find((i: { messageId: string }) => i.messageId === sent.messageId);
    expect(item).toMatchObject({ kind: "message", payload: { v: 2, event: { cls: "message", senderUserId: alice.userId, payload: { type: "text", text: "hello bob" } } } });
    const page = await bob.req("GET", `/v2/conversations/${dm}/messages`);
    expect(page.messages[0]).toMatchObject({ id: sent.messageId, payload: { text: "hello bob" }, importedBy: null });
    // Retrying the same id answers as a duplicate and stores nothing twice.
    const retry = await alice.req("POST", "/v2/messages", { conversationId: dm, messageId: sent.messageId, cls: "message", sentAt: Date.now(), payload: { type: "text", text: "hello bob" } });
    expect(retry).toMatchObject({ duplicate: true, serverTs: sent.serverTs });
    // Someone outside the conversation sees nothing (404, not a hint it exists).
    await expectStatus(carol.req("GET", `/v2/conversations/${dm}/messages`), 404);
    await expectStatus(send(carol, dm, { type: "text", text: "hi" }), 404);
  });

  it("pages history newest first with the changes to each page's messages", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await send(alice, dm, { type: "text", text: `n${i}` })).messageId);
    await change(bob, dm, { type: "reaction", target: ids[1], emoji: "👍", add: true });
    await change(alice, dm, { type: "edit", target: ids[1], text: "n1 edited" });
    const first = await bob.req("GET", `/v2/conversations/${dm}/messages?limit=2`);
    expect(first.messages.map((m: { id: string }) => m.id)).toEqual([ids[4], ids[3]]);
    expect(first.more).toBe(true);
    const second = await bob.req("GET", `/v2/conversations/${dm}/messages?limit=3&before=${first.messages[1].serverTs}`);
    expect(second.messages.map((m: { id: string }) => m.id)).toEqual([ids[2], ids[1], ids[0]]);
    expect(second.changes.map((c: { payload: { type: string } }) => c.payload.type)).toEqual(["reaction", "edit"]);
    // Around a message: the ones before and after it.
    const around = await bob.req("GET", `/v2/conversations/${dm}/messages?around=${ids[2]}&limit=2`);
    expect(around.messages.map((m: { id: string }) => m.id)).toEqual([ids[3], ids[2], ids[1]]);
  });

  it("only a message's sender edits or deletes it, and only in its own conversation", async () => {
    const { messageId } = await send(alice, dm, { type: "text", text: "mine" });
    await expectStatus(change(bob, dm, { type: "edit", target: messageId, text: "not yours" }), 403);
    await expectStatus(change(bob, dm, { type: "delete", target: messageId }), 403);
    const other = (await carol.req("POST", "/v1/conversations/dm", { userId: alice.userId })).conversation.id;
    await expectStatus(change(alice, other, { type: "delete", target: messageId }), 404);
    expect(await change(alice, dm, { type: "delete", target: messageId })).toMatchObject({ duplicate: false });
  });

  it("counts characters as people do against the sender's plan, edits included", async () => {
    const limited = await startServer({ MOJO_ENFORCE: "on" });
    try {
      const a = await limited.client("alice");
      const b = await limited.client("bob");
      const conv = (await a.req("POST", "/v1/conversations/dm", { userId: b.userId })).conversation.id;
      const free = (await a.req("GET", "/v2/mojo/catalog")).plans.find((p: { key: string }) => p.key === "free").messageChars as number;
      // A flag is two code points but one character.
      expect(await send(a, conv, { type: "text", text: "🇧🇩".repeat(free) })).toMatchObject({ duplicate: false });
      await expectStatus(send(a, conv, { type: "text", text: "x".repeat(free + 1) }), 413);
      const { messageId } = await send(a, conv, { type: "text", text: "short" });
      await expectStatus(change(a, conv, { type: "edit", target: messageId, text: "x".repeat(free + 1) }), 413);
    } finally {
      await limited.close();
    }
  });

  it("self-only changes reach only the sender's own devices and history", async () => {
    const { messageId } = await send(bob, dm, { type: "text", text: "read me" });
    await change(alice, dm, { type: "read", target: messageId, upTo: Date.now() }, { audience: "self" });
    const forAlice = await alice.req("GET", `/v2/conversations/${dm}/messages?limit=1`);
    expect(forAlice.changes.some((c: { payload: { type: string } }) => c.payload.type === "read")).toBe(true);
    const forBob = await bob.req("GET", `/v2/conversations/${dm}/messages?limit=1`);
    expect(forBob.changes.some((c: { payload: { type: string } }) => c.payload.type === "read")).toBe(false);
  });

  it("imports a device's earlier history once, marked with who uploaded it, only into its own conversations", async () => {
    const id = mid();
    const item = { id, conversationId: dm, senderUserId: bob.userId, cls: "message", sentAt: 1_700_000_000_000, serverTs: 1_700_000_000_001, payload: { type: "text", text: "from before" } };
    expect(await alice.req("POST", "/v2/messages/import", { items: [item] })).toEqual({ added: 1, skipped: 0 });
    expect(await bob.req("POST", "/v2/messages/import", { items: [item] })).toEqual({ added: 0, skipped: 1 });
    const outsider = { ...item, id: mid() };
    expect(await carol.req("POST", "/v2/messages/import", { items: [outsider] })).toEqual({ added: 0, skipped: 1 });
    const page = await bob.req("GET", `/v2/conversations/${dm}/messages?around=${id}&limit=2`);
    expect(page.messages.find((m: { id: string }) => m.id === id)).toMatchObject({ importedBy: alice.userId, serverTs: 1_700_000_000_001 });
  });

  it("summarises each conversation: newest message, read position, unread and mentions since", async () => {
    const g = (await alice.req("POST", "/v1/conversations/dm", { userId: carol.userId })).conversation.id;
    const first = await send(carol, g, { type: "text", text: "one" });
    await send(carol, g, { type: "text", text: "two", mentions: [alice.userId] });
    let s = (await alice.req("GET", "/v2/messages/summary")).conversations.find((c: { conversationId: string }) => c.conversationId === g);
    expect(s).toMatchObject({ unread: 2, mentions: 1, readUpTo: 0, last: { payload: { text: "two" } } });
    await change(alice, g, { type: "read", upTo: first.serverTs }, { audience: "self" });
    s = (await alice.req("GET", "/v2/messages/summary")).conversations.find((c: { conversationId: string }) => c.conversationId === g);
    expect(s).toMatchObject({ unread: 1, mentions: 1, readUpTo: first.serverTs });
    // Uploaded history was seen on the device that kept it: shown as the newest message, never counted as unread.
    const old = { id: mid(), conversationId: g, senderUserId: carol.userId, cls: "message", sentAt: Date.now(), serverTs: Date.now(), payload: { type: "text", text: "kept on a phone", mentions: [alice.userId] } };
    expect(await alice.req("POST", "/v2/messages/import", { items: [old] })).toEqual({ added: 1, skipped: 0 });
    s = (await alice.req("GET", "/v2/messages/summary")).conversations.find((c: { conversationId: string }) => c.conversationId === g);
    expect(s).toMatchObject({ unread: 1, mentions: 1, last: { payload: { text: "kept on a phone" } } });
    // Your own messages never count as unread for you.
    expect((await carol.req("GET", "/v2/messages/summary")).conversations.find((c: { conversationId: string }) => c.conversationId === g)).toMatchObject({ unread: 0 });
  });

  it("searches the text of messages in your own conversations", async () => {
    await send(alice, dm, { type: "text", text: "the Cozy Corner cafe at 6" });
    const hits = await bob.req("GET", `/v2/messages/search?q=${encodeURIComponent("cozy corner")}`);
    expect(hits.messages[0].payload.text).toContain("Cozy Corner");
    expect((await carol.req("GET", `/v2/messages/search?q=cozy`)).messages).toEqual([]);
  });

  it("tells an app from before the change to update, unless the server still takes encrypted envelopes", async () => {
    await expectStatus(
      alice.req("POST", "/v1/messages", { conversationId: dm, messageId: mid(), cls: "message", sentAt: Date.now(), nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AA==", signature: "x".repeat(88), recipients: [] }),
      426,
    );
    expect((await alice.req("GET", "/v1/server-info")).features).toContain("server-messages");
  });

  it("deletes a channel's stored messages with the channel", async () => {
    const { org } = await alice.req("POST", "/v1/orgs", { name: "Store Lab" });
    const channel = (await alice.req("POST", `/v1/orgs/${org.id}/channels`, { name: "doomed", scope: "ORG", kind: "PUBLIC" })).channel;
    await send(alice, channel.id, { type: "text", text: "soon gone" });
    await alice.req("DELETE", `/v1/conversations/${channel.id}`, { confirmName: "doomed" });
    expect((await h.ctx.messages.page(channel.id, alice.userId, null, 10)).messages).toEqual([]);
  });
});
