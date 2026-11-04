export class MeldiqBotError extends Error {
  constructor(status, code, message, retryAfterMs) {
    super(message);
    this.name = "MeldiqBotError";
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export function origin(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new TypeError(
      "Configure an API origin without credentials, path or query",
    );
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
  )
    throw new TypeError("Use HTTPS, or HTTP on loopback for local development");
  return url.origin;
}

export function credential(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("mqb_") ||
    value.length > 200 ||
    /\s/.test(value)
  )
    throw new TypeError("A Meldiq bot token is required");
  return value;
}

export function target(apiOrigin, path) {
  const url = new URL(path, apiOrigin);
  if (
    url.origin !== apiOrigin ||
    !url.pathname.startsWith("/v2/bot/") ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new TypeError(
      "Only native /v2/bot/ paths on the configured origin are allowed",
    );
  return url;
}

export async function readJson(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader)
    throw new MeldiqBotError(
      response.status,
      "invalid_response",
      "The bot API returned no response body",
    );
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new MeldiqBotError(
          response.status,
          "response_too_large",
          "The response exceeded the client budget; request a smaller page",
        );
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof MeldiqBotError) throw error;
    throw new MeldiqBotError(
      response.status,
      "invalid_response",
      "The bot API response was not valid JSON",
    );
  } finally {
    reader.releaseLock();
  }
}
