import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectStatus, type Harness, startServer } from "./support/harness.js";
import type { GriipClient } from "./support/griipClient.js";
let h: Harness;
let alice: GriipClient, bob: GriipClient;
beforeAll(async () => { h = await startServer(); [alice, bob] = await Promise.all([h.client("localalice"), h.client("localbob")]); });
afterAll(async () => h.close());
const get = (client: GriipClient) => client.req("GET", "/v1/me/preferences/personal");
const put = (client: GriipClient, baseRev: number, prefs: object) => client.req("PUT", "/v1/me/preferences/personal", { baseRev, prefs });
describe("optional interface locale", () => {
  it("advertises support without changing an existing account's language", async () => {
    expect((await get(alice)).prefs.locale).toBeNull();
  });
  it("synchronizes the personal choice and preserves it when an older client omits the field", async () => {
    let doc = await get(alice);
    doc = await put(alice, doc.rev, { locale: "ur" });
    expect(doc.prefs.locale).toBe("ur");
    doc = await put(alice, doc.rev, { collapsed: ["dms"] });
    expect(doc.prefs.locale).toBe("ur");
    expect(doc.prefs.collapsed).toEqual(["dms"]);
    expect((await get(bob)).prefs.locale).toBeNull();
  });
  it("keeps revision conflict protection and rejects unsupported values", async () => {
    const doc = await get(alice);
    await expectStatus(put(alice, doc.rev - 1, { locale: "ar" }), 409);
    for (const locale of ["xx", "pt", "<script>"]) await expectStatus(put(alice, doc.rev, { locale }), 400);
  });
  it("accepts the exact 28 locale variants and the explicit browser choice", async () => {
    let doc = await get(bob);
    for (const locale of ["system", "en", "bn", "hi", "ur", "zh-CN", "zh-TW", "ja", "ko", "id", "vi", "th", "ar", "tr", "pt-BR", "es-419", "es-ES", "fr", "de", "it", "nl", "pl", "ru", "uk", "ro", "sv", "cs", "el", "pt-PT"]) { doc = await put(bob, doc.rev, { locale }); expect(doc.prefs.locale).toBe(locale); }
  });
});
