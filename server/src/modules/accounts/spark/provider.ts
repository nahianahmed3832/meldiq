import { z } from "zod";
import { ApiError } from "../../../shared/errors.js";

export type SparkMessage = { role: "system" | "user" | "assistant"; content: string };
export interface SparkProvider {
  complete(messages: readonly SparkMessage[], signal: AbortSignal): AsyncIterable<string>;
}

import { SPARK_MAX_REPLY as MAX_REPLY } from "../../../shared/contracts/http/webExperience.js";
const MAX_BYTES = 128 * 1024;
const packet = z.union([z.strictObject({ delta: z.string().min(1) }), z.strictObject({ done: z.literal(true) })]);
const response = z.strictObject({ text: z.string().min(1).max(MAX_REPLY) });

/** Optional server-side transport for an operator-managed gateway. Nothing routes to the retired AI Workforce. */
export function configuredSparkProvider(env: NodeJS.ProcessEnv): SparkProvider | null {
  const target = env.MELDIQ_SPARK_ENDPOINT?.trim();
  const token = env.MELDIQ_SPARK_TOKEN?.trim();
  if (!target || !token) return null;
  let url: URL;
  try {
    url = new URL(target);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  } catch {
    return null;
  }

  return {
    async *complete(messages, signal) {
      const res = await fetch(url, {
        method: "POST",
        redirect: "error",
        signal,
        headers: { "content-type": "application/json", accept: "application/x-ndjson, application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ messages, maxOutputCharacters: MAX_REPLY }),
      });
      const kind = res.headers.get("content-type")?.split(";")[0]?.trim();
      if (!res.ok || !res.body || (kind !== "application/x-ndjson" && kind !== "application/json")) {
        await res.body?.cancel().catch(() => {});
        throw new ApiError(503, "provider_unavailable", "Spark could not reach its assistant service.");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let bytes = 0, pending = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            pending += decoder.decode();
            break;
          }
          bytes += value.byteLength;
          if (bytes > MAX_BYTES) throw new Error("Spark provider response too large");
          pending += decoder.decode(value, { stream: true });
          if (kind === "application/x-ndjson") {
            let newline: number;
            while ((newline = pending.indexOf("\n")) !== -1) {
              const line = pending.slice(0, newline).trim();
              pending = pending.slice(newline + 1);
              if (!line) continue;
              const p = packet.parse(JSON.parse(line));
              if ("done" in p) return;
              yield p.delta;
            }
          }
        }
        if (kind === "application/json") yield response.parse(JSON.parse(pending)).text;
        else if (!pending.trim() || !("done" in packet.parse(JSON.parse(pending)))) throw new Error("Spark provider stream ended early");
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
  };
}
