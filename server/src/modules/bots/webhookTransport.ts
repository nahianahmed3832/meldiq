import { createHmac, timingSafeEqual } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { request, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";
import { badRequest } from "../../shared/errors.js";

// Reject every special-use IPv4 range, including anycast exceptions. Do not fall back to IPv6.
const denied = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) denied.addSubnet(network, prefix, "ipv4");

const dnsName = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)$/;
export type BotWebhookConfig = { hosts: ReadonlySet<string>; master: Buffer };

export function botWebhookConfig(env: NodeJS.ProcessEnv): BotWebhookConfig | null {
  const domains = env.BOT_EVENT_WEBHOOK_HOSTS?.trim(), key = env.BOT_EVENT_WEBHOOK_MASTER_KEY?.trim();
  if (!domains && !key) return null;
  const hosts = new Set(domains?.split(",").map((host) => host.trim().toLowerCase()));
  if (!hosts.size || hosts.size > 32 || [...hosts].some((host) => !dnsName.test(host) || /\.(?:internal|local|localhost|test|invalid|example|onion|home|lan)$/.test(host)))
    throw new Error("BOT_EVENT_WEBHOOK_HOSTS must contain approved public hostnames");
  if (!key || !/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error("BOT_EVENT_WEBHOOK_MASTER_KEY must be a base64url 32-byte key");
  const master = Buffer.from(key, "base64url");
  if (master.length !== 32 || master.toString("base64url") !== key) throw new Error("BOT_EVENT_WEBHOOK_MASTER_KEY must be a canonical base64url key");
  return { hosts, master };
}

export function webhookDestination(value: string, hosts: ReadonlySet<string>): URL {
  let url: URL;
  try {
    if (!/^https:\/\//.test(value) || /[\s\\?#]/u.test(value)) throw new Error();
    url = new URL(value);
    if (url.protocol !== "https:" || url.port || url.username || url.password || !dnsName.test(url.hostname) ||
        isIP(url.hostname) || !hosts.has(url.hostname)) throw new Error();
  } catch {
    throw badRequest("Use an approved HTTPS event webhook hostname and a path without credentials, a query or a fragment");
  }
  return url;
}

type Lookup4 = (absoluteHost: string, signal: AbortSignal) => Promise<readonly string[]>;
const resolve: Lookup4 = async (host, signal) => {
  const resolver = new Resolver({ timeout: 1_500, tries: 1 });
  const abort = () => resolver.cancel();
  signal.throwIfAborted();
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await resolver.resolve4(host);
  } finally {
    signal.removeEventListener("abort", abort);
  }
};

export async function webhookAddress(host: string, signal: AbortSignal, lookup: Lookup4 = resolve): Promise<string> {
  const addresses = await lookup(host + ".", signal);
  signal.throwIfAborted();
  if (!addresses.length || addresses.length > 32 || addresses.some((address) => isIP(address) !== 4 || denied.check(address, "ipv4")))
    throw new Error("Invalid webhook DNS destination");
  return addresses[0]!;
}

export function webhookSecret(master: Buffer, botId: string, generation: string): Buffer {
  return createHmac("sha256", master).update(JSON.stringify(["meldiq.bot.webhook.key.v1", botId, generation])).digest();
}

export function webhookSignature(secret: Buffer, id: string, time: number, body: Buffer): string {
  return "v1=" + createHmac("sha256", secret).update(`meldiq.bot.webhook.v1\n${id}\n${time}\n`).update(body).digest("hex");
}

export function webhookProof(secret: Buffer, nonce: string): string {
  return "v1=" + createHmac("sha256", secret).update("meldiq.bot.webhook.verify.v1\n" + nonce).digest("hex");
}

export function matchesWebhookProof(actual: string, expected: string): boolean {
  return /^v1=[0-9a-f]{64}$/.test(actual) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

/** Use the approved DNS answer exactly once, with TLS hostname verification and no redirects or connection reuse. */
export async function deliverWebhook(
  url: URL,
  input: { id: string; secret: Buffer; body: Buffer; readProof?: boolean },
  signal: AbortSignal,
  authorize: () => Promise<boolean>,
  transport: { lookup?: Lookup4; request?: (url: URL, options: RequestOptions, receive: (response: IncomingMessage) => void) => ClientRequest } = {},
): Promise<{ status: number; proof: string } | undefined> {
  const address = await webhookAddress(url.hostname, signal, transport.lookup);
  // Avoid opening sockets on a stale claim. Recheck again after TLS and immediately before writing.
  if (!(await authorize())) return undefined;
  signal.throwIfAborted();
  const timestamp = Math.floor(Date.now() / 1000);
  return new Promise((resolveResult, reject) => {
    const req = (transport.request ?? request)(url, {
      method: "POST",
      signal,
      agent: false,
      family: 4,
      lookup: (_name, _options, done) => done(null, address, 4),
      servername: url.hostname,
      rejectUnauthorized: true,
      maxHeaderSize: 8 * 1024,
      headers: {
        "content-type": "application/json",
        "content-length": input.body.length,
        "meldiq-delivery-id": input.id,
        "meldiq-timestamp": String(timestamp),
        "meldiq-signature": webhookSignature(input.secret, input.id, timestamp, input.body),
      },
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (!input.readProof || status < 200 || status >= 300) {
        // A status is enough for event delivery. Do not read unbounded response bodies.
        resolveResult({ status, proof: "" });
        res.destroy();
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 100) {
          reject(new Error("Webhook proof exceeds its size limit"));
          res.destroy();
        }
      });
      res.once("end", () => resolveResult({ status, proof: body }));
      res.once("error", reject);
    });
    req.once("error", reject);
    req.once("socket", (socket) => {
      socket.once("secureConnect", () => {
        void authorize().then((allowed) => {
          if (!allowed) {
            resolveResult(undefined);
            req.destroy();
          } else if (!signal.aborted) req.end(input.body);
        }, (error) => req.destroy(error));
      });
    });
  });
}
