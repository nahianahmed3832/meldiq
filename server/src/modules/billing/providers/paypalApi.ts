import { ApiError } from "../../../shared/errors.js";

export interface PayPalApi {
  request(
    method: string,
    path: string,
    body?: unknown,
    requestId?: string,
  ): Promise<unknown>;
}

/** Sandbox is deliberately the only host. No environment value can select a live endpoint. */
export class HttpPayPalApi implements PayPalApi {
  private token: { value: string; until: number } | null = null;
  private authenticating: Promise<string> | null = null;
  constructor(
    private readonly clientId: string,
    private readonly secret: string,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    this.authenticating ??= (async () => {
      const res = await fetch(
        "https://api-m.sandbox.paypal.com/v1/oauth2/token",
        {
          method: "POST",
          signal: AbortSignal.timeout(15_000),
          headers: {
            authorization: `Basic ${Buffer.from(`${this.clientId}:${this.secret}`).toString("base64")}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "grant_type=client_credentials",
        },
      );
      const data = (await res.json()) as {
        access_token?: unknown;
        expires_in?: unknown;
      };
      if (
        !res.ok ||
        typeof data.access_token !== "string" ||
        typeof data.expires_in !== "number"
      )
        throw unavailable();
      this.token = {
        value: data.access_token,
        until: Date.now() + Math.max(0, data.expires_in - 60) * 1000,
      };
      return data.access_token;
    })()
      .catch(() => {
        throw unavailable();
      })
      .finally(() => {
        this.authenticating = null;
      });
    return this.authenticating;
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    requestId?: string,
  ): Promise<unknown> {
    if (!/^\/v[12]\/[A-Za-z0-9_/?=.&%-]+$/.test(path) || path.includes(".."))
      throw unavailable();
    try {
      const res = await fetch(`https://api-m.sandbox.paypal.com${path}`, {
        method,
        signal: AbortSignal.timeout(20_000),
        headers: {
          authorization: `Bearer ${await this.accessToken()}`,
          "content-type": "application/json",
          prefer: "return=representation",
          ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!res.ok) {
        await res.body?.cancel();
        if (res.status === 401) this.token = null;
        throw unavailable();
      }
      return res.status === 204 ? {} : await res.json();
    } catch {
      throw unavailable();
    }
  }
}

/** Never propagate PayPal response bodies, credentials, access tokens, or payer information into logs. */
const unavailable = () =>
  new ApiError(
    503,
    "unavailable",
    "PayPal Sandbox could not complete this request. Check billing status before trying again.",
  );
