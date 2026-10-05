import assert from "node:assert/strict";
import test from "node:test";
import { RunMetrics } from "../extension/core/runMetrics.js";
import { channelId, message, createHarness, historyHandler } from "./helpers.js";

function metricsHarness() {
  let now = 0;
  const metrics = new RunMetrics(() => now);
  return { metrics, advance: milliseconds => { now += milliseconds; } };
}

test("preview has elapsed time without a made-up rate or remaining history estimate", () => {
  const { metrics, advance } = metricsHarness();
  assert.deepEqual(metrics.snapshot({ phase: "idle", processed: 0, total: 0 }), { elapsedMs: 0, activeMs: 0, messagesPerMinute: null, remainingMs: null });
  metrics.start();
  advance(6000);
  metrics.endPhase();
  advance(9000);
  const state = metrics.snapshot({ phase: "ready", processed: 0, total: 50 });
  assert.equal(state.elapsedMs, 15000);
  assert.equal(state.activeMs, 6000);
  assert.equal(state.remainingMs, null);
  assert.equal(state.messagesPerMinute, null);
});

test("deletion rate excludes preview and pause time, while wall time includes them", () => {
  const { metrics, advance } = metricsHarness();
  metrics.start();
  advance(20000);
  metrics.endPhase();
  advance(10000);
  metrics.beginPhase("deleting");
  advance(3000);
  metrics.pause();
  metrics.pause();
  advance(12000);
  let state = metrics.snapshot({ phase: "deleting", processed: 3, total: 9 });
  assert.equal(state.elapsedMs, 45000);
  assert.equal(state.activeMs, 3000);
  assert.equal(state.messagesPerMinute, 60);
  assert.equal(state.remainingMs, 6000);
  metrics.resume();
  metrics.resume();
  advance(3000);
  state = metrics.snapshot({ phase: "deleting", processed: 3, total: 9 });
  assert.equal(state.messagesPerMinute, 30);
  assert.equal(state.remainingMs, 12000);
});

test("estimates wait for three processed messages and include a known cooldown floor", () => {
  const { metrics, advance } = metricsHarness();
  metrics.start();
  metrics.beginPhase("deleting");
  advance(3000);
  for (const processed of [0, 1, 2]) assert.equal(metrics.snapshot({ phase: "deleting", processed, total: 10 }).remainingMs, null);
  assert.equal(metrics.snapshot({ phase: "deleting", processed: 3, total: 10, waitUntil: 33000 }).remainingMs, 36000);
  advance(30000);
  const state = metrics.snapshot({ phase: "deleting", processed: 3, total: 10 });
  assert.equal(state.messagesPerMinute, 3 * 60000 / 33000);
  assert.equal(state.remainingMs, 77000);
});

test("finish freezes elapsed and throughput even during a pause; a new run resets them", () => {
  const { metrics, advance } = metricsHarness();
  metrics.start();
  metrics.beginPhase("deleting");
  advance(3000);
  metrics.pause();
  advance(6000);
  metrics.finish();
  advance(60000);
  const state = metrics.snapshot({ phase: "complete", processed: 3, total: 3 });
  assert.equal(state.elapsedMs, 9000);
  assert.equal(state.activeMs, 3000);
  assert.equal(state.messagesPerMinute, 60);
  assert.equal(state.remainingMs, 0);
  metrics.start();
  assert.equal(metrics.snapshot({ phase: "scanning", processed: 0, total: 0 }).elapsedMs, 0);
  assert.equal(metrics.snapshot({ phase: "scanning", processed: 0, total: 0 }).messagesPerMinute, null);
});

test("engine metrics follow paced deletion and freeze after completion", async () => {
  const harness = createHarness(historyHandler([message(4), message(3), message(2), message(1)]));
  await harness.wiper.preview(harness.config);
  const previewTime = harness.wiper.state.elapsedMs;
  assert.equal(harness.wiper.state.remainingMs, null);
  harness.advanceTime(10000);
  await harness.wiper.deletePreview({ channelId, acceptRisk: true });
  const state = harness.wiper.state;
  assert.ok(state.elapsedMs >= previewTime + 10000);
  assert.equal(state.remainingMs, 0);
  assert.equal(state.messagesPerMinute, 60);
  assert.ok(harness.changes.some(value => value.phase === "deleting" && value.deleted === 3 && value.remainingMs !== null));
  harness.advanceTime(60000);
  assert.deepEqual(harness.wiper.state, state);
});
