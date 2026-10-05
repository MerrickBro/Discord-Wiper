import { DiscordClient } from "../extension/core/discordClient.js";
import { RunControl, abortError } from "../extension/core/control.js";
import { MessageWiper } from "../extension/core/wiper.js";

export const channelId = "123456789012345678";
export const authorId = "223456789012345678";
export const otherId = "323456789012345678";
export const testToken = "fictional-unit-test-token-no-account";

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

export function message(offset, author = authorId, type = 0) {
  return { id: String(1450000000000000000n + BigInt(offset)), channel_id: channelId, author: { id: author }, type, content: "This content must not be retained." };
}

export function createHarness(handler, extra = {}) {
  const requests = [];
  const sleeps = [];
  const logs = [];
  const changes = [];
  let now = 1791182000000;
  const sleepImpl = extra.sleepImpl ?? (async (duration, signal) => {
    if (signal.aborted) throw abortError();
    sleeps.push(duration);
    now += duration;
  });
  const fetchImpl = async (url, options) => {
    const request = { url: new URL(url), method: options.method, options, time: now };
    requests.push(request);
    return handler(request, requests.length);
  };
  const control = new RunControl({ sleepImpl });
  const options = { token: testToken, minDelay: 1000, maxDelay: 2000, control, fetchImpl, clock: () => now,
    random: () => 0, onLog: (text, level) => logs.push({ text, level }) };
  const client = new DiscordClient(options);
  const wiper = new MessageWiper({
    onLog: (text, level) => logs.push({ text, level }),
    onChange: state => changes.push(state),
    controlFactory: () => control,
    clientFactory: engineOptions => new DiscordClient({ ...options, ...engineOptions }),
    ...(extra.maxCandidates ? { maxCandidates: extra.maxCandidates } : {})
  });
  return { requests, sleeps, logs, changes, control, client, wiper,
    config: { token: testToken, channelId, minDelay: 1000, maxDelay: 2000 } };
}

export function standardHandler(pages, deletionResponse = () => jsonResponse(null, 204)) {
  let pageIndex = 0;
  return request => {
    if (request.url.pathname === "/api/v10/users/@me") return jsonResponse({ id: authorId });
    if (request.url.pathname === `/api/v10/channels/${channelId}`) return jsonResponse({ id: channelId, type: 1 });
    if (request.method === "DELETE") return deletionResponse(request);
    return jsonResponse(pages[pageIndex++] ?? []);
  };
}

export function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

export const nextTurn = () => new Promise(resolve => setImmediate(resolve));
