import assert from "node:assert/strict";
import test from "node:test";
import { rateLimitDelay } from "../extension/core/discordClient.js";
import { channelId, testToken, createHarness, jsonResponse, message } from "./helpers.js";

test("only canonical Discord requests receive the token; cookies, redirects and caching are disabled", async () => {
  const harness = createHarness(() => jsonResponse({ id: channelId }));
  await harness.client.getSelf();
  await harness.client.getMessages(channelId, message(1).id);
  const request = harness.requests[1];
  assert.equal(request.url.origin, "https://discord.com");
  assert.equal(request.url.searchParams.get("limit"), "100");
  assert.equal(request.url.searchParams.get("before"), message(1).id);
  assert.equal(request.options.headers.Authorization, testToken);
  assert.equal(request.options.credentials, "omit");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.cache, "no-store");
  assert.ok(!request.url.href.includes(testToken));
  assert.deepEqual(Object.keys(harness.client), []);
});

test("429 chooses the longest advertised cooldown, then retries the same request", async () => {
  const harness = createHarness((request, count) => count === 1 ?
    jsonResponse({ retry_after: 1.1, global: false }, 429, { "Retry-After": "2.5", "X-RateLimit-Reset-After": "1.8" }) : jsonResponse([]));
  await harness.client.getMessages(channelId);
  assert.equal(harness.requests.length, 2);
  assert.equal(harness.requests[0].url.href, harness.requests[1].url.href);
  assert.ok(harness.requests[1].time - harness.requests[0].time >= 2750);
});

test("429 reads fractional retry_after from JSON when Retry-After is unavailable", async () => {
  const harness = createHarness((request, count) => count === 1 ? jsonResponse({ retry_after: 4.125 }, 429) : jsonResponse([]));
  await harness.client.getMessages(channelId);
  assert.deepEqual(harness.sleeps, [4375]);
});

test("global 429 blocks the whole serial stream, including the next route", async () => {
  const harness = createHarness((request, count) => count === 1 ?
    jsonResponse({ retry_after: 3, global: true }, 429, { "X-RateLimit-Global": "true" }) : jsonResponse({ id: channelId }));
  await harness.client.getSelf();
  await harness.client.getChannel(channelId);
  assert.ok(harness.requests[1].time - harness.requests[0].time >= 3250);
  assert.ok(harness.requests[2].time - harness.requests[1].time >= 1000);
  assert.ok(harness.logs.some(log => log.text.includes("Global rate limit")));
});

test("exhausted successful bucket prevents the next request until reset", async () => {
  const harness = createHarness((request, count) => jsonResponse({ id: channelId }, 200,
    count === 1 ? { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset-After": "4.75" } : {}));
  await harness.client.getSelf();
  await harness.client.getChannel(channelId);
  assert.deepEqual(harness.sleeps, [5000]);
});

test("Retry-After accepts HTTP dates and ignores malformed or negative values", () => {
  const now = Date.parse("2026-10-05T06:00:00Z");
  assert.equal(rateLimitDelay(new Headers({ "Retry-After": "Mon, 05 Oct 2026 06:00:05 GMT" }), {}, now), 5250);
  assert.equal(rateLimitDelay(new Headers({ "Retry-After": "not-a-date" }), { retry_after: -5 }, now), null);
  assert.equal(rateLimitDelay(new Headers({ "X-RateLimit-Reset": String((now + 10000) / 1000) }), {}, now), 10250);
});

test("429 without timing data backs off and eventually stops instead of spinning forever", async () => {
  const harness = createHarness(() => jsonResponse({ message: "rate limited" }, 429));
  await assert.rejects(harness.client.getSelf(), /six retries/);
  assert.equal(harness.requests.length, 7);
  assert.deepEqual(harness.sleeps, [5000, 10000, 20000, 40000, 60000, 60000]);
});

for (const status of [400, 401, 403, 404]) {
  test(`HTTP ${status} is not retried`, async () => {
    const harness = createHarness(() => jsonResponse({ message: testToken }, status));
    await assert.rejects(harness.client.getSelf());
    assert.equal(harness.requests.length, 1);
    assert.ok(!JSON.stringify(harness.logs).includes(testToken));
  });
}

test("unknown message 404 is already absent; unknown channel 404 is fatal", async () => {
  const gone = createHarness(() => jsonResponse({ code: 10008 }, 404));
  assert.deepEqual(await gone.client.deleteMessage(channelId, message(1).id), { alreadyGone: true });
  const missingChannel = createHarness(() => jsonResponse({ code: 10003 }, 404));
  await assert.rejects(missingChannel.client.deleteMessage(channelId, message(1).id), /HTTP 404/);
});

test("204 is successful deletion; an unexpected 200 is not treated as success", async () => {
  const harness = createHarness(() => jsonResponse(null, 204));
  assert.deepEqual(await harness.client.deleteMessage(channelId, message(1).id), { alreadyGone: false });
  const unexpected = createHarness(() => jsonResponse({}));
  await assert.rejects(unexpected.client.deleteMessage(channelId, message(1).id), /Unexpected deletion response/);
});

test("5xx and network retries are bounded", async () => {
  const server = createHarness(() => jsonResponse({}, 503));
  await assert.rejects(server.client.getSelf(), /three retries/);
  assert.equal(server.requests.length, 4);
  const network = createHarness(() => { throw new Error(testToken); });
  await assert.rejects(network.client.getSelf(), /Network requests failed repeatedly/);
  assert.equal(network.requests.length, 4);
  assert.ok(!JSON.stringify(network.logs).includes(testToken));
});

test("verification challenges halt with no retries or challenge solving", async () => {
  const harness = createHarness(() => jsonResponse({ captcha_key: ["required"], captcha_sitekey: "fictional" }, 400));
  await assert.rejects(harness.client.getSelf(), /additional verification/);
  assert.equal(harness.requests.length, 1);
});

test("dispose clears authentication capability; invalid IDs never reach fetch", async () => {
  const harness = createHarness(() => jsonResponse([]));
  assert.throws(() => harness.client.getMessages("../users/@me"), /valid Discord channel/);
  assert.throws(() => harness.client.deleteMessage(channelId, "../../x"), /Invalid message ID/);
  harness.client.dispose();
  await assert.rejects(harness.client.getSelf(), /token has been cleared/);
  assert.equal(harness.requests.length, 0);
});
