import {
  credential,
  origin,
  target,
  readJson,
  MeldiqBotError,
} from "./transport.mjs";
import { BotGateway } from "./gateway.mjs";
export { MeldiqBotError } from "./transport.mjs";

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
  async request(method, path, { body, bytes, signal } = {}) {
    if (
      !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) ||
      (body !== undefined && bytes !== undefined)
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
          accept: "application/json",
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
    const data = await readJson(response, this.maxResponseBytes);
    if (!response.ok) {
      const retry = Number(response.headers.get("retry-after"));
      throw new MeldiqBotError(
        response.status,
        data?.error?.code ?? "request_failed",
        data?.error?.message ?? "The bot API refused the request",
        Number.isFinite(retry) && retry > 0
          ? Math.min(retry, 86400) * 1000
          : undefined,
      );
    }
    return data;
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
  send(channelId, content, { messageId, replyTo, signal } = {}) {
    return this.request("POST", `/v2/bot/channels/${enc(channelId)}/messages`, {
      body: {
        content,
        ...(messageId ? { messageId } : {}),
        ...(replyTo ? { replyTo } : {}),
      },
      signal,
    });
  }
  sendDirect(userId, content, { messageId, replyTo, signal } = {}) {
    return this.request("POST", `/v2/bot/users/${enc(userId)}/dm`, {
      body: {
        content,
        ...(messageId ? { messageId } : {}),
        ...(replyTo ? { replyTo } : {}),
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
