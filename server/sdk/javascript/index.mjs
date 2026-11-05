import { createHmac, timingSafeEqual } from "node:crypto";
import {
  credential,
  origin,
  target,
  readJson,
  MeldiqBotError,
} from "./transport.mjs";
import { BotGateway } from "./gateway.mjs";
export { MeldiqBotError } from "./transport.mjs";

const eventDeliveryId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function webhookKey(secret) {
  if (typeof secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new TypeError("Invalid event webhook signing secret");
  const bytes = Buffer.from(secret, "base64url");
  if (bytes.toString("base64url") !== secret) throw new TypeError("Invalid event webhook signing secret");
  return bytes;
}

/** Authenticate exact bytes and timestamp. Use deliveryId as a durable deduplication key before applying side effects. */
export function verifyEventWebhook(secret, { deliveryId, timestamp, signature }, body, now = Math.floor(Date.now() / 1000)) {
  if (typeof deliveryId !== "string" || !eventDeliveryId.test(deliveryId) ||
      typeof timestamp !== "string" || !/^[1-9][0-9]{0,11}$/.test(timestamp) ||
      typeof signature !== "string" || !/^v1=[0-9a-f]{64}$/.test(signature) ||
      !Number.isSafeInteger(now) || Math.abs(now - Number(timestamp)) > 300 ||
      !(body instanceof Uint8Array) || body.byteLength > 4096) return false;
  const expected = createHmac("sha256", webhookKey(secret)).update(`meldiq.bot.webhook.v1\n${deliveryId}\n${timestamp}\n`).update(body).digest();
  return timingSafeEqual(Buffer.from(signature.slice(3), "hex"), expected);
}

/** Return as the exact text body for a verified endpoint.verify challenge. */
export function eventWebhookProof(secret, nonce) {
  if (typeof nonce !== "string" || !eventDeliveryId.test(nonce)) throw new TypeError("Invalid event webhook challenge");
  return "v1=" + createHmac("sha256", webhookKey(secret)).update("meldiq.bot.webhook.verify.v1\n" + nonce).digest("hex");
}

const enc = encodeURIComponent;
/** First-party native client. Tokens stay out of URLs, public fields, logs and redirect targets. */
export class MeldiqBot {
  #token;
  constructor({
    apiOrigin,
    token,
    timeoutMs = 30_000,
    maxResponseBytes = 16 * 1024 * 1024,
  }) {
    this.apiOrigin = origin(apiOrigin);
    this.#token = credential(token);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000)
      throw new TypeError("Invalid request timeout");
    if (
      !Number.isInteger(maxResponseBytes) ||
      maxResponseBytes < 1024 ||
      maxResponseBytes > 64 * 1024 * 1024
    )
      throw new TypeError("Invalid response budget");
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
  }
  async #response(
    method,
    path,
    { body, bytes, signal, binary = false, range } = {},
  ) {
    if (
      !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) ||
      (body !== undefined && bytes !== undefined) ||
      (range !== undefined &&
        (method !== "GET" ||
          typeof range !== "string" ||
          !/^bytes=\d+-\d*$/.test(range)))
    )
      throw new TypeError("Invalid bot request");
    const url = target(this.apiOrigin, path);
    let response;
    try {
      response = await fetch(url, {
        method,
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
          : AbortSignal.timeout(this.timeoutMs),
        headers: {
          authorization: `Bot ${this.#token}`,
          accept: binary ? "application/octet-stream" : "application/json",
          ...(range !== undefined ? { range } : {}),
          ...(bytes
            ? { "content-type": "application/octet-stream" }
            : body !== undefined
              ? { "content-type": "application/json" }
              : {}),
        },
        ...(bytes !== undefined
          ? { body: bytes }
          : body !== undefined
            ? { body: JSON.stringify(body) }
            : {}),
      });
    } catch {
      if (signal?.aborted)
        throw new MeldiqBotError(0, "aborted", "The bot request was cancelled");
      throw new MeldiqBotError(
        0,
        "network_error",
        "The bot API request failed or timed out",
      );
    }
    return response;
  }
  #refused(response, data) {
    const retry = Number(response.headers.get("retry-after"));
    return new MeldiqBotError(
      response.status,
      data?.error?.code ?? "request_failed",
      data?.error?.message ?? "The bot API refused the request",
      Number.isFinite(retry) && retry > 0
        ? Math.min(retry, 86400) * 1000
        : undefined,
    );
  }
  async request(method, path, options) {
    const response = await this.#response(method, path, options);
    const data = await readJson(response, this.maxResponseBytes);
    if (!response.ok) throw this.#refused(response, data);
    return data;
  }
  uploadAttachment(channelId, ciphertext, { signal } = {}) {
    if (!(ciphertext instanceof Uint8Array) || !ciphertext.byteLength)
      throw new TypeError("Encrypted attachment bytes are required");
    return this.request(
      "POST",
      `/v2/bot/attachments?conversationId=${enc(channelId)}`,
      { bytes: ciphertext, signal },
    );
  }
  startUpload(channelId, size, sha256, options = {}) {
    return this.request("POST", "/v2/bot/attachments/uploads", {
      ...options,
      body: { conversationId: channelId, size, sha256 },
    });
  }
  uploadUrl(id, options) {
    return this.request(
      "POST",
      `/v2/bot/attachments/uploads/${enc(id)}/url`,
      options,
    );
  }
  signUploadParts(id, parts, options = {}) {
    return this.request(
      "POST",
      `/v2/bot/attachments/uploads/${enc(id)}/parts`,
      { ...options, body: { parts } },
    );
  }
  uploadedParts(id, options) {
    return this.request(
      "GET",
      `/v2/bot/attachments/uploads/${enc(id)}/parts`,
      options,
    );
  }
  completeUpload(id, parts, options = {}) {
    return this.request(
      "POST",
      `/v2/bot/attachments/uploads/${enc(id)}/complete`,
      { ...options, body: parts ? { parts } : {} },
    );
  }
  cancelUpload(id, options) {
    return this.request(
      "DELETE",
      `/v2/bot/attachments/uploads/${enc(id)}`,
      options,
    );
  }
  /** Async bytes; breaking iteration cancels the response. No redirect or automatic retry forwards the bot token. */
  async *downloadAttachment(id, { signal, range } = {}) {
    const response = await this.#response(
      "GET",
      `/v2/bot/attachments/${enc(id)}`,
      { signal, range, binary: true },
    );
    if (!response.ok)
      throw this.#refused(
        response,
        await readJson(response, this.maxResponseBytes),
      );
    if (!response.body)
      throw new MeldiqBotError(
        0,
        "invalid_response",
        "The attachment response had no body",
      );
    try {
      for await (const chunk of response.body) yield chunk;
    } catch {
      if (signal?.aborted)
        throw new MeldiqBotError(
          0,
          "aborted",
          "The attachment download was cancelled",
        );
      throw new MeldiqBotError(
        0,
        "download_failed",
        "The attachment download was interrupted",
      );
    }
  }
  me(options) {
    return this.request("GET", "/v2/bot/me", options);
  }
  communities(options) {
    return this.request("GET", "/v2/bot/communities", options);
  }
  events({ cursor, limit = 50, signal } = {}) {
    const query = new URLSearchParams({
      limit: String(limit),
      ...(cursor ? { cursor } : {}),
    });
    return this.request("GET", `/v2/bot/events?${query}`, { signal });
  }
  send(
    channelId,
    content,
    {
      messageId,
      replyTo,
      embeds,
      buttons,
      components,
      componentsTtlSeconds,
      attachments,
      signal,
    } = {},
  ) {
    return this.request("POST", `/v2/bot/channels/${enc(channelId)}/messages`, {
      body: {
        content,
        ...(messageId ? { messageId } : {}),
        ...(replyTo ? { replyTo } : {}),
        ...(embeds ? { embeds } : {}),
        ...(buttons ? { buttons } : {}),
        ...(components ? { components } : {}),
        ...(componentsTtlSeconds !== undefined ? { componentsTtlSeconds } : {}),
        ...(attachments ? { attachments } : {}),
      },
      signal,
    });
  }
  sendDirect(
    userId,
    content,
    {
      messageId,
      replyTo,
      embeds,
      buttons,
      components,
      componentsTtlSeconds,
      signal,
    } = {},
  ) {
    return this.request("POST", `/v2/bot/users/${enc(userId)}/dm`, {
      body: {
        content,
        ...(messageId ? { messageId } : {}),
        ...(replyTo ? { replyTo } : {}),
        ...(embeds ? { embeds } : {}),
        ...(buttons ? { buttons } : {}),
        ...(components ? { components } : {}),
        ...(componentsTtlSeconds !== undefined ? { componentsTtlSeconds } : {}),
      },
      signal,
    });
  }
  setCommands(commands, options = {}) {
    return this.request("PUT", "/v2/bot/commands", {
      ...options,
      body: { commands },
    });
  }
  joinVoice(
    channelId,
    { requestId = crypto.randomUUID(), waitForMember = false, signal } = {},
  ) {
    if (typeof waitForMember !== "boolean")
      throw new TypeError("waitForMember must be a boolean");
    return this.request("POST", "/v2/bot/voice", {
      body: {
        channelId,
        requestId,
        ...(waitForMember ? { waitForMember: true } : {}),
      },
      signal,
    });
  }
  voiceKey(leaseId, options) {
    return this.request("GET", `/v2/bot/voice/${enc(leaseId)}/key`, options);
  }
  renewVoice(leaseId, options) {
    return this.request(
      "POST",
      `/v2/bot/voice/${enc(leaseId)}/heartbeat`,
      options,
    );
  }
  voiceConnected(leaseId, options) {
    return this.request(
      "POST",
      `/v2/bot/voice/${enc(leaseId)}/connected`,
      options,
    );
  }
  leaveVoice(leaseId, options) {
    return this.request("DELETE", `/v2/bot/voice/${enc(leaseId)}`, options);
  }
  interactions({ wait = 20, signal } = {}) {
    return this.request(
      "GET",
      `/v2/bot/interactions?wait=${enc(String(wait))}`,
      { signal },
    );
  }
  reply(id, content, { ephemeral = false, signal } = {}) {
    return this.request("POST", `/v2/bot/interactions/${enc(id)}/reply`, {
      body: { content, ephemeral },
      signal,
    });
  }
  uploadAvatar(bytes, { animated = true, signal } = {}) {
    return this.request(
      "PUT",
      `/v2/bot/users/me/${animated ? "avatar-media" : "photo"}`,
      { bytes, signal },
    );
  }
  uploadBanner(bytes, options = {}) {
    return this.request("PUT", "/v2/bot/users/me/profile-banner", {
      ...options,
      bytes,
    });
  }
  async openGateway(options = {}) {
    return new BotGateway({
      ...options,
      apiOrigin: this.apiOrigin,
      token: this.#token,
    }).open();
  }
}
