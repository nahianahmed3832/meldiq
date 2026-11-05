import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer, request } from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  botWebhookConfig, deliverWebhook, webhookAddress, webhookDestination, webhookProof, webhookSignature,
} from "../src/modules/bots/webhookTransport.js";

import { verifyEventWebhook, eventWebhookProof } from "../sdk/javascript/index.mjs";

const hostname = "hook.meldiq.net";
const hosts = new Set([hostname]);
const secret = randomBytes(32);

it("requires exact operator hosts and refuses credentials, redirects by URL, address literals and unsafe DNS answers", async () => {
  expect(botWebhookConfig({})).toBeNull();
  expect(() => botWebhookConfig({ BOT_EVENT_WEBHOOK_HOSTS: "*.meldiq.net", BOT_EVENT_WEBHOOK_MASTER_KEY: secret.toString("base64url") })).toThrow();
  expect(webhookDestination("https://" + hostname + "/events", hosts).hostname).toBe(hostname);
  for (const url of [
    "http://" + hostname, `https://${hostname}:444`, `https://${hostname}/p?q=x`,
    `https://${hostname}/p#secret`, `https://other.net@${hostname}`, `https://${hostname}@other.net`,
    "https://127.1", "https://[::ffff:127.0.0.1]", `https://${hostname}\\@other.net`,
  ]) expect(() => webhookDestination(url, hosts)).toThrow();
  for (const address of ["127.0.0.2", "10.42.0.1", "169.254.169.254", "100.100.100.200", "192.168.1.2",
    "172.22.0.1", "192.0.0.10", "203.0.113.1", "198.19.1.1", "224.1.1.1", "240.0.1.1", "::ffff:10.0.0.1", "::1"]) {
    await expect(webhookAddress(hostname, AbortSignal.timeout(500), async () => ["93.184.216.34", address])).rejects.toThrow();
  }
  const lookup = vi.fn(async () => ["93.184.216.34", "8.8.8.8"]);
  await expect(webhookAddress(hostname, AbortSignal.timeout(500), lookup)).resolves.toBe("93.184.216.34");
  expect(lookup).toHaveBeenCalledWith(hostname + ".", expect.any(AbortSignal));
});

it("ships interoperable JS and Python proof and signature checks that reject altered bytes and stale timestamps", () => {
  const nonce = randomUUID(), stamp = 1_799_000_000, body = Buffer.from('{"type":"event","fixture":"✓"}');
  const key = secret.toString("base64url");
  const mac = webhookSignature(secret, nonce, stamp, body);
  const headers = { deliveryId: nonce, timestamp: String(stamp), signature: mac };
  expect(verifyEventWebhook(key, headers, body, stamp)).toBe(true);
  expect(verifyEventWebhook(key, headers, Buffer.from("modified"), stamp)).toBe(false);
  expect(verifyEventWebhook(key, headers, body, stamp + 301)).toBe(false);
  expect(verifyEventWebhook(key, { ...headers, deliveryId: randomUUID() }, body, stamp)).toBe(false);
  expect(eventWebhookProof(key, nonce)).toBe(webhookProof(secret, nonce));
  const python = execFileSync("python3", ["-B", "-c", [
    "import json, sys", "sys.path.insert(0, 'sdk/python')",
    "from meldiq_bot import verify_event_webhook, event_webhook_proof",
    "key, nonce, stamp, signature, text = json.load(sys.stdin)", "body = text.encode('utf-8')",
    "assert verify_event_webhook(key, nonce, str(stamp), signature, body, stamp)",
    "assert not verify_event_webhook(key, nonce, str(stamp), signature, body, stamp + 301)",
    "assert not verify_event_webhook(key, nonce, str(stamp), signature, body + b' ', stamp)",
    "print(event_webhook_proof(key, nonce))",
  ].join("\n")], { input: JSON.stringify([key, nonce, stamp, mac, body.toString()]), encoding: "utf8" }).trim();
  expect(python).toBe(webhookProof(secret, nonce));
});

describe("real isolated TLS receiver (connector maps the verified DNS address to test loopback)", () => {
  const root = mkdtempSync(join(tmpdir(), "meldiq-webhook-tls-"));
  let key: Buffer, cert: Buffer, server: ReturnType<typeof createServer>, port: number;
  const received = new Map<string, { body: Buffer; valid: boolean; duplicate: boolean }>();
  const visits: string[] = [];
  beforeAll(async () => {
    execFileSync("openssl", ["req", "-x509", "-nodes", "-newkey", "rsa:2048", "-sha256", "-days", "2",
      "-subj", "/CN=" + hostname, "-keyout", join(root, "test-key.pem"), "-out", join(root, "test-cert.pem")], { stdio: "ignore" });
    key = readFileSync(join(root, "test-key.pem")); cert = readFileSync(join(root, "test-cert.pem"));
    server = createServer({ key, cert }, (req, res) => {
      visits.push(req.url!);
      const parts: Buffer[] = [];
      req.on("data", (part) => parts.push(part));
      req.on("end", () => {
        const body = Buffer.concat(parts);
        const id = String(req.headers["meldiq-delivery-id"]), stamp = Number(req.headers["meldiq-timestamp"]);
        const mac = createHmac("sha256", secret).update(`meldiq.bot.webhook.v1\n${id}\n${stamp}\n`).update(body).digest("hex");
        const valid = Number.isSafeInteger(stamp) && Math.abs(Math.floor(Date.now() / 1000) - stamp) < 300 &&
          req.headers["meldiq-signature"] === "v1=" + mac;
        const duplicate = received.has(id);
        received.set(id, { body, valid, duplicate });
        if (req.url === "/hang") return;
        if (req.url === "/redirect") {
          res.writeHead(302, { location: "https://" + hostname + "/unexpected" }).end();
          return;
        }
        if (req.url === "/prove") {
          res.end(webhookProof(secret, JSON.parse(body.toString()).nonce));
          return;
        }
        res.writeHead(valid ? (duplicate ? 200 : 204) : 401).end();
      });
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((closed) => server.close(() => closed()));
    rmSync(root, { recursive: true, force: true });
  });

  const post = (path: string, options: { id?: string; body?: Buffer; timeout?: number; auth?: () => Promise<boolean>; proof?: boolean; trustedCert?: boolean } = {}) =>
    deliverWebhook(webhookDestination("https://" + hostname + path, hosts), {
      id: options.id ?? randomUUID(), body: options.body ?? Buffer.from('{"type":"event"}'), secret, readProof: options.proof,
    }, AbortSignal.timeout(options.timeout ?? 1500), options.auth ?? (async () => true), {
      lookup: async () => ["93.184.216.34"],
      request: (url, requestOptions, cb) => {
        const lookup = requestOptions.lookup!;
        return request(url, { ...requestOptions, ca: options.trustedCert === false ? undefined : cert, port,
          lookup: (name, opts, next) => {
            lookup(name, opts, (error, address, family) => {
              expect(error).toBeNull();
              expect(address).toBe("93.184.216.34");
              expect(family).toBe(4);
              next(null, "127.0.0.1", 4);
            });
          },
        }, cb);
      },
    });

  it("authenticates TLS, signs raw bytes, proves secret possession, and gives retries a replay/deduplication identity", async () => {
    const id = randomUUID(), body = Buffer.from('{"type":"event","nonAscii":"✓"}');
    await expect(post("/event", { id, body })).resolves.toMatchObject({ status: 204 });
    expect(received.get(id)).toEqual({ body, valid: true, duplicate: false });
    await expect(post("/event", { id, body })).resolves.toMatchObject({ status: 200 });
    expect(received.get(id)).toEqual({ body, valid: true, duplicate: true });
    const nonce = randomUUID();
    await expect(post("/prove", { body: Buffer.from(JSON.stringify({ nonce })), proof: true })).resolves.toMatchObject({ proof: webhookProof(secret, nonce) });
    await expect(post("/untrusted", { trustedCert: false })).rejects.toThrow(/certificate/);
    expect(visits).not.toContain("/untrusted");
  });

  it("never follows redirect, stops stalled responses, and writes no request after revocation at the TLS boundary", async () => {
    await expect(post("/redirect")).resolves.toMatchObject({ status: 302 });
    expect(visits).not.toContain("/unexpected");
    await expect(post("/hang", { timeout: 300 })).rejects.toThrow(/aborted/);
    const auth = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(post("/revoked", { auth })).resolves.toBeUndefined();
    expect(auth).toHaveBeenCalledTimes(2);
    expect(visits).not.toContain("/revoked");
  });
});
