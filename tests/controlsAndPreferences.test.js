import assert from "node:assert/strict";
import test from "node:test";
import { RunControl } from "../extension/core/control.js";
import { SessionLease } from "../extension/core/sessionLease.js";
import { cleanPreferences, loadPreferences, savePreferences } from "../extension/core/preferences.js";
import { channelFromPath, validateDelays, validateToken } from "../extension/core/validation.js";
import { channelId, testToken, nextTurn } from "./helpers.js";

test("stopping interrupts a long delay without waiting for its timer", async () => {
  const control = new RunControl();
  const task = control.sleep(60000);
  const rejected = assert.rejects(task, { name: "AbortError" });
  await nextTurn();
  control.stop();
  await rejected;
});

test("stop wakes paused control and resume wakes normal paused checkpoints", async () => {
  const control = new RunControl();
  control.pause();
  let finished = false;
  const waiting = control.checkpoint().then(() => { finished = true; });
  await nextTurn();
  assert.equal(finished, false);
  control.resume();
  await waiting;
  control.pause();
  const stopped = assert.rejects(control.checkpoint(), { name: "AbortError" });
  control.stop();
  await stopped;
});

test("preferences whitelist excludes tokens, author IDs, logs and deletion state", async () => {
  const input = { token: testToken, authorId: channelId, log: testToken, messageIds: [channelId],
    dateEnabled: true, dateMode: "during", dateFrom: "2026-10-01", dateTo: "2026-10-04",
    wordEnabled: true, wordMode: "containing", wordQuery: "private filter phrase",
    minDelay: 1500, maxDelay: 2500, channelId, rememberChannel: false, theme: "light" };
  const clean = cleanPreferences(input);
  assert.deepEqual(clean, { minDelay: 1500, maxDelay: 2500, channelId: "", rememberChannel: false, theme: "light" });
  const storage = { data: {}, async set(values) { this.data = values; }, async get() { return this.data; } };
  await savePreferences(storage, input);
  assert.ok(!JSON.stringify(storage.data).includes(testToken));
  assert.ok(!JSON.stringify(storage.data).includes("private filter phrase"));
  assert.deepEqual(await loadPreferences(storage), clean);
  await savePreferences(storage, { ...input, rememberChannel: true });
  assert.equal((await loadPreferences(storage)).channelId, channelId);
  await savePreferences(storage, { ...input, rememberChannel: false });
  assert.equal((await loadPreferences(storage)).channelId, "");
});

test("invalid persisted preferences fall back to valid defaults", () => {
  assert.deepEqual(cleanPreferences({ minDelay: 0, maxDelay: -1, token: testToken, theme: "evil" }),
    { minDelay: 1000, maxDelay: 2000, rememberChannel: false, channelId: "", theme: "dark" });
});

test("IDs are derived only from channel routes; delay and token inputs reject malformed values", () => {
  assert.equal(channelFromPath(`/channels/@me/${channelId}`), channelId);
  assert.equal(channelFromPath(`/channels/423456789012345678/${channelId}/999`), channelId);
  for (const path of ["/channels/@me", "/login", "/channels/x/123", `/channels/@me/${channelId}evil`]) assert.equal(channelFromPath(path), "");
  for (const [minimum, maximum] of [[0, 1000], [2000, 1000], [1000, 60001], [1000.5, 2000], [NaN, 2000]]) assert.throws(() => validateDelays(minimum, maximum));
  assert.throws(() => validateToken(`Bearer ${testToken}`));
  assert.throws(() => validateToken(""));
});

test("session lease blocks a simultaneous tab, then allows it after release", async () => {
  let active = false;
  const locks = { async request(name, options, callback) {
    if (active) return callback(null);
    active = true;
    try { return await callback({ name }); } finally { active = false; }
  } };
  const first = new SessionLease(locks);
  const second = new SessionLease(locks);
  await first.acquire();
  await assert.rejects(second.acquire(), /Another Discord tab/);
  await first.release();
  await second.acquire();
  await second.release();
  assert.equal(active, false);
});

test("unsupported browser fails closed before creating a session", async () => {
  await assert.rejects(new SessionLease(null).acquire(), /does not support/);
});
