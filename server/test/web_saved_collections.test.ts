import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { expectStatus, startServer } from "./support/harness.js";

it("organizes canonical saved messages, deduplicates membership, and isolates collections", async () => {
  const h = await startServer();
  try {
    const [alice, bob] = await Promise.all([h.client("collectalice"), h.client("collectbob")]);
    const dm = (await alice.req("POST", "/v1/conversations/dm", { userId: bob.userId })).conversation.id;
    const path = "/v2/me/saved-collections";
    expect(await alice.req("POST", "/v2/search", { q: bob.username, types: "people", limit: 5 })).toMatchObject({ results: { people: { items: [{ id: bob.userId }] } } });
    const id = randomUUID();
    const messageId = "m_reference";
    await alice.req("PUT", "/v1/me/preferences/personal", {
      baseRev: 0, prefs: { saved: [{ conversationId: dm, messageId, savedAt: 100, remindAt: 200 }] },
    });
    expect(await alice.req("POST", path, { op: "create", id, name: "  Project  " })).toEqual({
      collections: [{ id, name: "Project", messageIds: [] }],
    });
    await expectStatus(bob.req("POST", path, { op: "rename", id, name: "Hijack" }), 404);
    await expectStatus(alice.req("POST", path, { op: "add", id, messageId: "m_not_saved" }), 404);
    await expectStatus(alice.req("GET", "/v1/me/preferences/saved-collections"), 404);
    for (let i = 0; i < 2; i++) await alice.req("POST", path, { op: "add", id, messageId });
    await alice.req("POST", path, { op: "rename", id, name: "Launch" });
    expect(await alice.req("GET", path)).toEqual({ collections: [{ id, name: "Launch", messageIds: [messageId] }] });
    expect(await bob.req("GET", path)).toEqual({ collections: [] });
    await alice.req("POST", path, { op: "remove", id, messageId });
    expect((await alice.req("GET", path)).collections[0].messageIds).toEqual([]);
    await alice.req("POST", path, { op: "add", id, messageId });
    await alice.req("POST", path, { op: "delete", id });
    expect(await alice.req("GET", path)).toEqual({ collections: [] });
    expect((await alice.req("GET", "/v1/me/preferences/personal")).prefs.saved).toEqual([
      { conversationId: dm, messageId, savedAt: 100, remindAt: 200, done: false },
    ]);
  } finally {
    await h.close();
  }
});
