import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GriipClient } from "./support/griipClient.js";
import { type Harness, startServer } from "./support/harness.js";

const mid = () => crypto.randomBytes(12).toString("base64url");
const send = (c: GriipClient, conversationId: string, text: string) =>
  c.req("POST", "/v2/messages", { conversationId, messageId: mid(), cls: "message", sentAt: Date.now(), payload: { type: "text", text } });
const read = (c: GriipClient, conversationId: string, upTo: number, audience: "all" | "self" = "all") =>
  c.req("POST", "/v2/messages", { conversationId, messageId: mid(), cls: "control", sentAt: Date.now(), payload: { type: "read", upTo }, ...(audience === "self" ? { audience } : {}) });

interface Change {
  senderUserId: string;
  payload: { type: string; upTo?: number };
}
const readsIn = (page: { changes: Change[] }) => page.changes.filter((c) => c.payload.type === "read");

/**
 * The owner's bug (2026-10-29): your messages showed "seen" until a reload, then a single tick. A read receipt names no
 * message (`{ type: "read", upTo }`), so history's changes, chosen by target, never carried it: an app that rebuilds a
 * conversation from history (the web app on every page load) never learned the other person had read it.
 */
const backends = process.env.MELDIQ_TEST_PG_URL ? [["postgresql", ""]] : [
  ["sqlite", ""],
  ["mongodb", "history"],
];
describe.each(backends)("history carries the other members' read receipts (%s)", (_backend, domains) => {
  let h: Harness;
  let alice: GriipClient, bob: GriipClient;
  let dm: string;
  beforeAll(async () => {
    h = await startServer({ MESSAGES_ACCEPT_ENCRYPTED: "false", ...(domains ? { MONGODB_DOMAINS: domains } : {}) });
    alice = await h.client("alice");
    bob = await h.client("bob");
    dm = (await alice.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
  });
  afterAll(async () => h.close());

  it("serves each other member's newest read receipt with every page, and never the viewer's own", async () => {
    const sent: { serverTs: number }[] = [];
    for (let i = 0; i < 3; i++) sent.push(await send(alice, dm, `m${i}`));
    await read(bob, dm, sent[1].serverTs);
    await read(bob, dm, sent[2].serverTs);
    // Bob's reading on his own devices only (a channel's "self" marker) is his alone.
    await read(bob, dm, sent[2].serverTs + 1, "self");
    // Alice's own receipt for Bob: her apps know their own read position from the summary.
    const fromBob = await send(bob, dm, "seen?");
    await read(alice, dm, fromBob.serverTs);

    const newest = await alice.req("GET", `/v2/conversations/${dm}/messages?limit=2`);
    expect(readsIn(newest)).toEqual([expect.objectContaining({ senderUserId: bob.userId, payload: { type: "read", upTo: sent[2].serverTs } })]);
    // An older page (scrolling up) carries it too: the app applies it to the messages it just loaded.
    const older = await alice.req("GET", `/v2/conversations/${dm}/messages?limit=2&before=${newest.messages[1].serverTs}`);
    expect(readsIn(older)).toEqual([expect.objectContaining({ senderUserId: bob.userId, payload: { type: "read", upTo: sent[2].serverTs } })]);
    // Around a message too, and the changes stay oldest first.
    const around = await alice.req("GET", `/v2/conversations/${dm}/messages?around=${newest.messages[1].id}&limit=2`);
    expect(readsIn(around).map((c) => c.payload.upTo)).toEqual([sent[2].serverTs]);
    const ts = around.changes.map((c: { serverTs: number }) => c.serverTs);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    // The web uses collection pages for its main timeline, files, pins and threads.
    const collection = await alice.req("GET", `/v2/conversations/${dm}/message-collections?kind=main&limit=2`);
    expect(readsIn(collection)).toEqual([expect.objectContaining({ senderUserId: bob.userId, payload: { type: "read", upTo: sent[2].serverTs } })]);
    const cursor = collection.nextCursor;
    const collectionOlder = await alice.req("GET", `/v2/conversations/${dm}/message-collections?kind=main&limit=2&before=${cursor.serverTs}&beforeId=${cursor.id}`);
    expect(readsIn(collectionOlder)).toEqual(readsIn(collection));
    // Bob sees Alice's receipt, not his own.
    const forBob = await bob.req("GET", `/v2/conversations/${dm}/messages?limit=2`);
    expect(readsIn(forBob)).toEqual([expect.objectContaining({ senderUserId: alice.userId, payload: { type: "read", upTo: fromBob.serverTs } })]);
  });
});
