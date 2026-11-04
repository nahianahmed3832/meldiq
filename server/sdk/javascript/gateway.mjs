import { credential, origin, MeldiqBotError } from "./transport.mjs";

/** Native v1 gateway. Batch handlers finish before their cursor is checkpointed. No automatic privilege retry. */
export class BotGateway {
  #token;
  #socket;
  #options;
  #cursor;
  #heartbeat;
  #deadline;
  #ready;
  #resolveReady;
  #rejectReady;
  #readyDone = false;
  #closed;
  #resolveClosed;
  #finished = false;
  #failure;
  #queue = Promise.resolve();
  #jobs = 0;
  #requests = new Map();
  #nextId = 0;
  #lastAck = Date.now();
  #consumer = new AbortController();

  constructor({
    apiOrigin,
    token,
    cursor,
    onBatch = async () => {},
    onCursor = async () => {},
    signal,
  }) {
    this.apiOrigin = origin(apiOrigin);
    this.#token = credential(token);
    this.#options = { onBatch, onCursor, signal };
    this.#cursor = cursor;
    this.#ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
  }
  get cursor() {
    return this.#cursor;
  }
  get closed() {
    return this.#closed;
  }
  async open() {
    if (this.#socket)
      throw new TypeError("This gateway instance was opened already");
    if (this.#options.signal?.aborted)
      throw new MeldiqBotError(0, "aborted", "Gateway opening was cancelled");
    const url = new URL("/v2/bot/gateway", this.apiOrigin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.#socket = new WebSocket(url);
    this.#deadline = setTimeout(
      () =>
        this.#fail(
          new MeldiqBotError(
            0,
            "gateway_timeout",
            "Gateway identification timed out",
          ),
        ),
      15_000,
    );
    this.#deadline.unref?.();
    const abort = () => this.close();
    this.#options.signal?.addEventListener("abort", abort, { once: true });
    this.#socket.addEventListener("message", (event) => {
      try {
        this.#receive(event.data);
      } catch (error) {
        this.#fail(
          error instanceof MeldiqBotError
            ? error
            : new MeldiqBotError(
                0,
                "invalid_frame",
                "The gateway sent an invalid frame",
              ),
        );
      }
    });
    this.#socket.addEventListener("error", () =>
      this.#fail(
        new MeldiqBotError(0, "network_error", "Gateway connection failed"),
      ),
    );
    this.#socket.addEventListener("close", (event) => {
      this.#options.signal?.removeEventListener("abort", abort);
      this.#finish(event.code);
    });
    return this.#ready;
  }
  #send(value) {
    if (this.#finished || this.#socket?.readyState !== 1)
      throw new MeldiqBotError(
        0,
        "not_connected",
        "The bot gateway is not connected",
      );
    const text = JSON.stringify(value);
    if (new TextEncoder().encode(text).length > 8192)
      throw new MeldiqBotError(
        0,
        "frame_too_large",
        "The gateway request exceeded its frame budget",
      );
    this.#socket.send(text);
  }
  #append(run) {
    if (++this.#jobs > 64) {
      this.#jobs--;
      this.#fail(
        new MeldiqBotError(
          0,
          "consumer_backpressure",
          "The event consumer fell behind; resume from its last committed cursor",
        ),
      );
      return;
    }
    this.#queue = this.#queue
      .then(async () => {
        if (!this.#finished && !this.#failure) await run();
      })
      .catch((error) => {
        if (!this.#finished)
          this.#fail(
            error instanceof MeldiqBotError
              ? error
              : new MeldiqBotError(
                  0,
                  "consumer_failed",
                  "The event handler failed; its cursor was not committed",
                ),
          );
      })
      .finally(() => {
        this.#jobs--;
      });
  }
  #checkpoint(cursor) {
    if (
      typeof cursor !== "string" ||
      !cursor.startsWith("be1.") ||
      cursor.length > 640
    )
      throw new MeldiqBotError(
        0,
        "invalid_cursor",
        "The gateway returned an invalid cursor",
      );
    return Promise.resolve(this.#options.onCursor(cursor)).then(() => {
      this.#cursor = cursor;
    });
  }
  #receive(data) {
    if (
      typeof data !== "string" ||
      new TextEncoder().encode(data).length > 1024 * 1024
    )
      throw new Error("frame budget");
    const frame = JSON.parse(data);
    if (!frame || typeof frame !== "object" || typeof frame.op !== "string")
      throw new Error("frame shape");
    if (frame.op === "hello") {
      if (
        this.#heartbeat ||
        frame.version !== 1 ||
        !Number.isInteger(frame.heartbeatIntervalMs) ||
        frame.heartbeatIntervalMs < 1000 ||
        frame.heartbeatIntervalMs > 60_000
      )
        throw new Error("unsupported gateway");
      this.#send({
        op: this.#cursor ? "resume" : "identify",
        token: this.#token,
        ...(this.#cursor ? { cursor: this.#cursor } : {}),
      });
      this.#heartbeat = setInterval(
        () => {
          if (Date.now() - this.#lastAck > frame.heartbeatIntervalMs * 2) {
            this.#fail(
              new MeldiqBotError(
                0,
                "heartbeat_timeout",
                "The gateway stopped acknowledging heartbeats",
              ),
            );
            return;
          }
          try {
            this.#send({ op: "heartbeat", nonce: String(Date.now()) });
          } catch (error) {
            this.#fail(error);
          }
        },
        Math.max(1000, Math.floor(frame.heartbeatIntervalMs / 2)),
      );
      this.#heartbeat.unref?.();
    } else if (frame.op === "ready" || frame.op === "resumed") {
      if (frame.version !== 1 || this.#readyDone)
        throw new Error("unexpected ready");
      this.#readyDone = true;
      clearTimeout(this.#deadline);
      this.#resolveReady(this);
    } else if (frame.op === "heartbeat_ack") {
      this.#lastAck = Date.now();
      // A renewed cursor can pass delivered batches. Checkpoint it only after those batches finish.
      if (frame.cursor) this.#append(() => this.#checkpoint(frame.cursor));
    } else if (frame.op === "events") {
      if (
        !this.#readyDone ||
        !Array.isArray(frame.events) ||
        frame.events.length > 100
      )
        throw new Error("unexpected events");
      this.#append(async () => {
        await this.#options.onBatch(frame.events, {
          signal: this.#consumer.signal,
        });
        await this.#checkpoint(frame.cursor);
      });
    } else if (frame.op === "response") {
      // Resolve RPCs outside the batch queue: a handler may await a gateway request itself.
      const request = this.#requests.get(frame.requestId);
      if (!request) return;
      this.#requests.delete(frame.requestId);
      clearTimeout(request.timer);
      if (frame.ok === true) request.resolve(frame.data);
      else
        request.reject(
          new MeldiqBotError(
            0,
            frame.error?.code ?? "request_failed",
            frame.error?.message ?? "The gateway request failed",
          ),
        );
    } else if (frame.op !== "presence_ack")
      throw new Error("unsupported frame");
  }
  request(action, data) {
    if (!["self", "communities", "events"].includes(action))
      return Promise.reject(
        new TypeError("Use native HTTP for this operation"),
      );
    const requestId = `r-${++this.#nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#requests.delete(requestId);
        reject(
          new MeldiqBotError(
            0,
            "request_timeout",
            "The gateway request timed out",
          ),
        );
      }, 15_000);
      timer.unref?.();
      this.#requests.set(requestId, { resolve, reject, timer });
      try {
        this.#send({
          op: "request",
          requestId,
          action,
          ...(action === "events" ? { data: data ?? {} } : {}),
        });
      } catch (error) {
        clearTimeout(timer);
        this.#requests.delete(requestId);
        reject(error);
      }
    });
  }
  setPresence(status) {
    if (!["online", "idle", "dnd", "offline"].includes(status))
      throw new TypeError("Invalid bot presence");
    this.#send({ op: "presence", status });
  }
  close() {
    try {
      this.#socket?.close(1000, "client closing");
    } catch {
      this.#finish(1000);
    }
  }
  #fail(error) {
    this.#failure ??= error;
    try {
      this.#socket?.close(4000, "client stopping");
    } catch {
      this.#finish(4000);
    }
  }
  #finish(code) {
    if (this.#finished) return;
    this.#finished = true;
    clearInterval(this.#heartbeat);
    clearTimeout(this.#deadline);
    this.#consumer.abort();
    const statuses = {
      4400: 400,
      4401: 401,
      4403: 403,
      4408: 408,
      4410: 410,
      4429: 429,
      4503: 503,
      1012: 503,
    };
    if (code !== 1000)
      this.#failure ??= new MeldiqBotError(
        statuses[code] ?? 0,
        "gateway_closed",
        `The gateway closed (${code}); check current credentials, permissions and replay cursor`,
      );
    for (const request of this.#requests.values()) {
      clearTimeout(request.timer);
      request.reject(
        this.#failure ??
          new MeldiqBotError(0, "gateway_closed", "The gateway closed"),
      );
    }
    this.#requests.clear();
    if (!this.#readyDone)
      this.#rejectReady(
        this.#failure ??
          new MeldiqBotError(
            0,
            "gateway_closed",
            "The gateway closed before identifying",
          ),
      );
    void this.#queue.finally(() =>
      this.#resolveClosed({
        code,
        ...(this.#failure ? { error: this.#failure } : {}),
      }),
    );
  }
}
