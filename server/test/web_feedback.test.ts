import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { setBugStatus } from "../src/modules/accounts/bugReports.js";
import { AccountClient, MemoryMailer, PASSWORD } from "./support/accounts.js";
import { expectStatus, startServer } from "./support/harness.js";

it("keeps categorized submissions private and reviewable, suppresses duplicates, and erases new user data", async () => {
  const mailer = new MemoryMailer();
  const h = await startServer({}, { mailer });
  try {
    const alice = await AccountClient.ready(h.baseUrl, mailer, "feedbackowner");
    const bob = await h.client("otherperson");
    const path = "/v1/bug-reports";
    const data = { category: "feature", summary: "Collection sharing", details: "Let people explicitly share a collection." };
    const [a, b] = await Promise.all([alice.req("POST", path, data), alice.req("POST", path, data)]);
    expect(a.report.id).toEqual(b.report.id);
    expect(a.report.category).toBe("feature");
    expect((await bob.req("GET", path)).reports).toEqual([]);
    expect(await setBugStatus(h.ctx.safety, a.report.id, "confirmed", "Under review")).toBe(true);
    expect(await alice.req("GET", path)).toMatchObject({ reports: [{ id: a.report.id, staffNote: "Under review" }], bugHunter: false });
    await expectStatus(alice.req("POST", path, { ...data, category: "other" }), 400);
    const old = await alice.req("POST", path, { summary: "Legacy report", details: "Legacy submissions are still accepted." });
    expect(old.report.category).toBe("bug");
    await setBugStatus(h.ctx.safety, old.report.id, "fixed", null);
    expect((await alice.req("GET", path)).bugHunter).toBe(true);
    for (let i = 0; i < 8; i++) await alice.req("POST", path, { ...data, summary: `Feature idea ${i}` });
    await expectStatus(alice.req("POST", path, { ...data, summary: "Over limit" }), 429);
    expect((await alice.req("GET", path)).reports).toHaveLength(10);
    await alice.req("POST", "/v2/me/saved-collections", { op: "create", id: randomUUID(), name: "Delete with account" });
    await h.ctx.safety.write((w) => w.insert("spark_threads", { id: randomUUID(), user_id: alice.userId, sealed: "test-only-placeholder", updated_at: Date.now() }));
    await alice.req("DELETE", "/v2/account", { password: PASSWORD, confirmEmail: alice.email });
    expect(await h.ctx.prefs.get(alice.userId, "saved-collections")).toBeNull();
    expect(h.ctx.safety.count("spark_threads", { user_id: alice.userId })).toBe(0);
    expect(h.ctx.safety.count("bug_reports", { user_id: alice.userId })).toBe(0);
  } finally {
    await h.close();
  }
});
