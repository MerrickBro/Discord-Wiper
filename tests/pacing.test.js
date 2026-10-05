import assert from "node:assert/strict";
import test from "node:test";
import { pacePresets, paceFromDelays } from "../extension/core/pacing.js";
import { validateDelays } from "../extension/core/validation.js";
import { channelId, createHarness, jsonResponse } from "./helpers.js";

test("presets preserve balanced defaults and expose faster and custom delays", () => {
  assert.deepEqual(pacePresets.balanced, { minDelay: 1000, maxDelay: 2000 });
  assert.deepEqual(pacePresets.faster, { minDelay: 500, maxDelay: 750 });
  assert.equal(paceFromDelays(500, 750), "faster");
  assert.equal(paceFromDelays(1000, 2000), "balanced");
  assert.equal(paceFromDelays(250, 250), "custom");
  assert.deepEqual(validateDelays(250, 60000), { minDelay: 250, maxDelay: 60000 });
  assert.throws(() => validateDelays(249, 500));
});

test("faster pacing honors the selected floor without concurrent requests", async () => {
  const harness = createHarness(() => jsonResponse({ id: channelId }), pacePresets.faster);
  await harness.client.getSelf();
  await harness.client.getChannel(channelId);
  await harness.client.getMessages(channelId);
  assert.deepEqual(harness.sleeps, [500, 500]);
});

test("a rate limit slows faster pacing, then five successes ease it back", async () => {
  const harness = createHarness((request, count) => count === 1 ?
    jsonResponse({ retry_after: 0.1 }, 429, { "Retry-After": "0.1" }) : jsonResponse({ id: channelId }), pacePresets.faster);
  await harness.client.getSelf();
  for (let index = 0; index < 5; index++) await harness.client.getSelf();
  assert.deepEqual(harness.sleeps, [1000, 1000, 1000, 1000, 1000, 500]);
  assert.ok(harness.logs.some(log => log.text.includes("Pacing increased")));
});

test("custom short delays never override a longer exhausted-bucket cooldown", async () => {
  const harness = createHarness((request, count) => jsonResponse({ id: channelId }, 200,
    count === 1 ? { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset-After": "9.75" } : {}), { minDelay: 250, maxDelay: 250 });
  await harness.client.getSelf();
  await harness.client.getChannel(channelId);
  assert.deepEqual(harness.sleeps, [10000]);
});

test("401 exposes a fixed code so the UI can forget a rejected saved token", async () => {
  const harness = createHarness(() => jsonResponse({}, 401));
  await assert.rejects(harness.client.getSelf(), error => error.code === "invalidToken");
  assert.equal(harness.requests.length, 1);
});
