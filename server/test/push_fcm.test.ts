import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FcmConfig, fcmConfig, FcmService, type FetchFn, serviceAccountAssertion } from "../src/modules/notifications/fcm.js";
import type { GriipClient } from "./support/griipClient.js";
import { expectStatus, type Harness, startServer } from "./support/harness.js";

/**
 * Firebase Cloud Messaging wake-ups (round 6, docs/PUSH_FCM.md) against a fake Google: configuration checks, the signed
 * service-account assertion, data-only wake-ups with no content, token clean-up and the device routes. No real Firebase
 * project is involved, so delivery to a phone is not verified here.
 */
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meldiq-fcm-"));
const saFile = path.join(dir, "sa.json");
fs.writeFileSync(saFile, JSON.stringify({ type: "service_account", project_id: "meldiq-test-1", client_email: "push@meldiq-test-1.iam.gserviceaccount.com", private_key: pem }));

interface Sent {
  url: string;
  body: string;
  headers: Record<string, string>;
}

function fakeGoogle(answer: (url: string, body: string) => { status: number; body: unknown }) {
  const sent: Sent[] = [];
  const fn: FetchFn = async (url, init) => {
    sent.push({ url, body: init.body, headers: init.headers });
    const a = answer(url, init.body);
    return { status: a.status, json: async () => a.body };
  };
  return { sent, fn };
}

const tokenOk = (url: string) => (url === "https://oauth2.googleapis.com/token" ? { status: 200, body: { access_token: "ya29.test", expires_in: 3600 } } : null);

describe("FCM configuration", () => {
  it("is off without settings and refuses half or wrong ones", () => {
    expect(fcmConfig({})).toBeNull();
    expect(() => fcmConfig({ FCM_PROJECT_ID: "meldiq-test-1" })).toThrow(/both/);
    expect(() => fcmConfig({ FCM_PROJECT_ID: "other-project-9", FCM_SERVICE_ACCOUNT_FILE: saFile })).toThrow(/another project/);
    expect(() => fcmConfig({ FCM_PROJECT_ID: "meldiq-test-1", FCM_SERVICE_ACCOUNT_FILE: path.join(dir, "missing.json") })).toThrow(/can't be read/);
    expect(fcmConfig({ FCM_PROJECT_ID: "meldiq-test-1", FCM_SERVICE_ACCOUNT_FILE: saFile })).toMatchObject({ projectId: "meldiq-test-1", wakeIntervalMs: 30_000 });
  });

  it("signs the token request with the service account's key for the messaging scope only", () => {
    const jwt = serviceAccountAssertion({ clientEmail: "push@meldiq-test-1.iam.gserviceaccount.com", privateKey: pem }, Date.UTC(2026, 9, 19));
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(c, "base64url").toString());
    expect(claims).toMatchObject({ iss: "push@meldiq-test-1.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token" });
    expect(claims.exp - claims.iat).toBe(3600);
    expect(crypto.verify("RSA-SHA256", Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });
});

describe("FCM wake-ups", () => {
  let h: Harness;
  let alice: GriipClient;
  let cfg: FcmConfig;

  beforeAll(async () => {
    h = await startServer({ FCM_PROJECT_ID: "meldiq-test-1", FCM_SERVICE_ACCOUNT_FILE: saFile });
    alice = await h.client("fcmalice");
    cfg = h.ctx.config.fcm!;
  });
  afterAll(async () => h.close());

  const token = "fcm-registration-token:APA91b_test-1234567890";

  it("advertises the feature and lets a device register and remove its own token", async () => {
    expect((await alice.req("GET", "/v1/server-info")).features).toContain("push-fcm");
    await expectStatus(alice.req("PUT", "/v1/devices/current/fcm", { token: "short" }), 400);
    const r = await alice.req("PUT", "/v1/devices/current/fcm", { token });
    expect(r.push.kind).toBe("fcm");
    expect(await alice.req("DELETE", "/v1/devices/current/fcm")).toEqual({ ok: true, removed: true });
    await alice.req("PUT", "/v1/devices/current/fcm", { token });
  });

  it("sends a data-only wake-up with nothing in it, at most once per interval unless urgent", async () => {
    const g = fakeGoogle((url) => tokenOk(url) ?? { status: 200, body: { name: "projects/meldiq-test-1/messages/1" } });
    const fcm = new FcmService(h.ctx.identity, h.ctx.hub, cfg, h.ctx.log, g.fn);
    expect(await fcm.wake(alice.deviceId, false)).toBe("sent");
    const send = g.sent.find((s) => s.url.endsWith("/messages:send"))!;
    expect(send.url).toBe("https://fcm.googleapis.com/v1/projects/meldiq-test-1/messages:send");
    expect(send.headers.authorization).toBe("Bearer ya29.test");
    expect(JSON.parse(send.body)).toEqual({ message: { token, data: { w: "1" }, android: { priority: "HIGH", ttl: "86400s" } } });
    expect(await fcm.wake(alice.deviceId, false)).toBe("skipped"); // within the interval
    expect(await fcm.wake(alice.deviceId, true)).toBe("sent"); // a ring or a reminder doesn't wait
    // One access token for both sends.
    expect(g.sent.filter((s) => s.url === "https://oauth2.googleapis.com/token")).toHaveLength(1);
  });

  it("doesn't wake a device that is connected", async () => {
    const g = fakeGoogle((url) => tokenOk(url) ?? { status: 200, body: {} });
    const fcm = new FcmService(h.ctx.identity, h.ctx.hub, cfg, h.ctx.log, g.fn);
    await alice.connect();
    expect(await fcm.wake(alice.deviceId, true)).toBe("skipped");
    await alice.disconnect();
    // The server notices the closed socket a moment later.
    for (let i = 0; i < 50 && h.ctx.hub.isDeviceOnline(alice.deviceId); i++) await new Promise((r) => setTimeout(r, 20));
    expect(h.ctx.hub.isDeviceOnline(alice.deviceId)).toBe(false);
  });

  it("drops a token Firebase no longer accepts, and keeps one that only failed briefly", async () => {
    const flaky = fakeGoogle((url) => tokenOk(url) ?? { status: 503, body: { error: { status: "UNAVAILABLE" } } });
    expect(await new FcmService(h.ctx.identity, h.ctx.hub, cfg, h.ctx.log, flaky.fn).wake(alice.deviceId, true)).toBe("failed");
    expect(h.ctx.identity.get("fcm_tokens", { device_id: alice.deviceId })).toBeTruthy();
    const gone = fakeGoogle((url) => tokenOk(url) ?? { status: 404, body: { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } } });
    expect(await new FcmService(h.ctx.identity, h.ctx.hub, cfg, h.ctx.log, gone.fn).wake(alice.deviceId, true)).toBe("dropped");
    expect(h.ctx.identity.get("fcm_tokens", { device_id: alice.deviceId })).toBeUndefined();
  });

  it("keeps the token when only the UnifiedPush endpoint is withdrawn, and forgets it on sign-out", async () => {
    await alice.req("PUT", "/v1/devices/current/fcm", { token });
    // The app withdraws UnifiedPush whenever no distributor app is installed: that mustn't end Firebase wake-ups.
    await alice.req("DELETE", "/v1/devices/current/push");
    expect(h.ctx.identity.get("fcm_tokens", { device_id: alice.deviceId })).toBeTruthy();
    await alice.req("POST", "/v1/auth/logout");
    expect(h.ctx.identity.get("fcm_tokens", { device_id: alice.deviceId })).toBeUndefined();
  });
});
