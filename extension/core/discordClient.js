import { abortError } from "./control.js";
import { isSnowflake, validateChannelId, validateDelays, validateToken, WiperError } from "./validation.js";

const apiBase = "https://discord.com/api/v10";
const safetyMargin = 250;

function secondsToMs(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : null;
}

/** Discord uses seconds (including fractions); HTTP-date Retry-After is also accepted. */
export function rateLimitDelay(headers, body, now) {
  const retryAfter = headers.get("Retry-After");
  const headerMs = secondsToMs(retryAfter);
  const dateMs = headerMs === null && retryAfter ? Date.parse(retryAfter) - now : null;
  const resetAfter = secondsToMs(headers.get("X-RateLimit-Reset-After"));
  const resetEpoch = secondsToMs(headers.get("X-RateLimit-Reset"));
  const values = [headerMs, dateMs, secondsToMs(body?.retry_after), resetAfter,
    resetEpoch === null ? null : resetEpoch - now].filter(value => Number.isFinite(value) && value >= 0);
  return values.length ? Math.max(...values) + safetyMargin : null;
}

class NetworkError extends Error {}

/** One serialized request stream. Tokens are private and never leave Authorization headers. */
export class DiscordClient {
  #token;
  #control;
  #fetchImpl;
  #clock;
  #random;
  #onWait;
  #onLog;
  #onRateLimit;
  #minDelay;
  #maxDelay;
  #nextRequestAt = 0;
  #cooldownUntil = 0;
  #busy = false;
  #disposed = false;
  #requestTimeout;

  constructor({ token, minDelay = 1000, maxDelay = 2000, control,
    fetchImpl = globalThis.fetch.bind(globalThis), clock = Date.now, random = Math.random,
    onWait = () => {}, onLog = () => {}, onRateLimit = () => {}, requestTimeout = 30000 }) {
    this.#token = validateToken(token);
    ({ minDelay: this.#minDelay, maxDelay: this.#maxDelay } = validateDelays(minDelay, maxDelay));
    this.#control = control;
    this.#fetchImpl = fetchImpl;
    this.#clock = clock;
    this.#random = random;
    this.#onWait = onWait;
    this.#onLog = onLog;
    this.#onRateLimit = onRateLimit;
    this.#requestTimeout = requestTimeout;
  }

  dispose() {
    this.#token = "";
    this.#disposed = true;
  }

  getSelf() { return this.#request("GET", "/users/@me"); }

  getChannel(channelId) {
    return this.#request("GET", `/channels/${validateChannelId(channelId)}`);
  }

  getMessages(channelId, before = "") {
    if (before && !isSnowflake(before)) throw new WiperError("Invalid pagination cursor. Stopped.");
    const query = new URLSearchParams({ limit: "100" });
    if (before) query.set("before", before);
    return this.#request("GET", `/channels/${validateChannelId(channelId)}/messages?${query}`);
  }

  deleteMessage(channelId, messageId) {
    if (!isSnowflake(messageId)) throw new WiperError("Invalid message ID. Stopped.");
    return this.#request("DELETE", `/channels/${validateChannelId(channelId)}/messages/${messageId}`);
  }

  async #waitForSlot() {
    for (;;) {
      await this.#control.checkpoint();
      if (this.#disposed) throw new WiperError("The token has been cleared. Start a new preview.");
      const until = Math.max(this.#nextRequestAt, this.#cooldownUntil);
      const remaining = until - this.#clock();
      if (remaining <= 0) break;
      this.#onWait({ until, reason: this.#cooldownUntil >= this.#nextRequestAt ? "Discord cooldown" : "Request delay" });
      await this.#control.sleep(Math.min(remaining, 60000));
    }
    this.#onWait({ until: 0, reason: "" });
  }

  async #fetchOnce(method, path) {
    const requestController = new AbortController();
    const onAbort = () => requestController.abort();
    this.#control.signal.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      requestController.abort();
    }, this.#requestTimeout);
    try {
      if (this.#control.signal.aborted) throw abortError();
      const response = await this.#fetchImpl(`${apiBase}${path}`, {
        method,
        headers: { Authorization: this.#token, Accept: "application/json" },
        signal: requestController.signal,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer"
      });
      const body = response.status === 204 ? null : await response.json().catch(() => null);
      if (this.#control.signal.aborted) throw abortError();
      if (timedOut) throw new NetworkError();
      return { response, body };
    } catch (error) {
      if (this.#control.signal.aborted) throw abortError();
      throw new NetworkError();
    } finally {
      clearTimeout(timeout);
      this.#control.signal.removeEventListener("abort", onAbort);
    }
  }

  async #request(method, path) {
    if (this.#busy) throw new WiperError("Concurrent requests are disabled.");
    this.#busy = true;
    let rateRetries = 0;
    let transientRetries = 0;
    try {
      for (;;) {
        await this.#waitForSlot();
        let result;
        try {
          result = await this.#fetchOnce(method, path);
        } catch (error) {
          if (!(error instanceof NetworkError)) throw error;
          if (++transientRetries > 3) throw new WiperError("Network requests failed repeatedly. Stopped; check your connection before starting again.");
          this.#cooldownUntil = Math.max(this.#cooldownUntil, this.#clock() + 1000 * 2 ** transientRetries);
          this.#onLog("Connection interrupted. Waiting before a bounded retry.", "warning");
          continue;
        }
        const { response, body } = result;
        const now = this.#clock();
        const pacingDelay = this.#minDelay + Math.floor(this.#random() * (this.#maxDelay - this.#minDelay + 1));
        this.#nextRequestAt = now + pacingDelay;
        if (body?.captcha_key || body?.captcha_sitekey) {
          throw new WiperError("Discord requested additional verification. Stopped; complete it in Discord manually.");
        }
        const headerDelay = rateLimitDelay(response.headers, null, now);
        if (response.headers.get("X-RateLimit-Remaining") === "0" && headerDelay !== null) {
          this.#cooldownUntil = Math.max(this.#cooldownUntil, now + headerDelay);
        }
        if (response.status === 429) {
          const retryDelay = rateLimitDelay(response.headers, body, now) ?? Math.min(60000, 5000 * 2 ** rateRetries);
          this.#cooldownUntil = Math.max(this.#cooldownUntil, now + retryDelay);
          const globalLimit = body?.global === true || response.headers.get("X-RateLimit-Global") === "true" ||
            response.headers.get("X-RateLimit-Scope") === "global";
          this.#onRateLimit();
          this.#onLog(`${globalLimit ? "Global rate limit" : "Rate limit"}: waiting at least ${(retryDelay / 1000).toFixed(2)} s.`, "warning");
          if (++rateRetries > 6) throw new WiperError("Discord continued rate-limiting this request. Stopped after six retries.");
          continue;
        }
        if (response.status === 401) throw new WiperError("Discord rejected the token (401). It has been cleared; no further requests will be made.");
        if (response.status === 403) throw new WiperError("Discord denied access (403). Stopped; check channel access and account restrictions.");
        if (response.status === 404 && method === "DELETE" && body?.code === 10008) return { alreadyGone: true };
        if (response.status >= 500 && response.status <= 599) {
          if (++transientRetries > 3) throw new WiperError("Discord returned repeated server errors. Stopped after three retries.");
          this.#cooldownUntil = Math.max(this.#cooldownUntil, now + 1000 * 2 ** transientRetries, now + (headerDelay ?? 0));
          this.#onLog("Discord returned a server error. Waiting before a bounded retry.", "warning");
          continue;
        }
        if (response.status < 200 || response.status >= 300) {
          throw new WiperError(`Discord rejected the request (HTTP ${response.status}). Stopped without further retries.`);
        }
        if (method === "DELETE") {
          if (response.status !== 204) throw new WiperError("Unexpected deletion response. Stopped rather than assuming success.");
          return { alreadyGone: false };
        }
        if (response.status !== 200 || body === null) throw new WiperError("Discord returned an unreadable response. Stopped.");
        return body;
      }
    } finally {
      this.#busy = false;
      this.#onWait({ until: 0, reason: "" });
    }
  }
}
