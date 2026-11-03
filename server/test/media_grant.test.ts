import { describe, expect, it } from "vitest";
import { mediaDeliveryConfig, mediaUrl, openMediaGrant } from "../src/infrastructure/storage/mediaDelivery.js";
describe("scoped private media grant", () => {
  it("binds the file, expiration, API key and independent worker identity", () => {
    const cfg = mediaDeliveryConfig({MEDIA_PUBLIC_BASE_URL:"https://media.meldiq.app",MEDIA_GRANT_KEY:"01".repeat(32),MEDIA_EDGE_SECRET:"02".repeat(32)})!;
    const url = new URL(mediaUrl(cfg,"first","session-secret",1000));
    const grant = url.searchParams.get("ticket");
    expect(url.href).not.toContain("session-secret");
    expect(openMediaGrant(cfg,"first",grant,cfg.edge,60999)).toBe("session-secret");
    expect(openMediaGrant(cfg,"other",grant,cfg.edge,2000)).toBeUndefined();
    expect(openMediaGrant(cfg,"first",grant,cfg.edge,61000)).toBeUndefined();
    expect(openMediaGrant(cfg,"first",grant,"03".repeat(32),2000)).toBeUndefined();
  });
});
