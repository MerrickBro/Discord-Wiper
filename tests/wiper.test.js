import assert from "node:assert/strict";
import test from "node:test";
import { channelId, authorId, otherId, testToken, createHarness, jsonResponse, message, standardHandler, deferred, nextTurn } from "./helpers.js";

test("scans past full pages with no matches; only verified own messages enter the deletion snapshot", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => message(400 - index, index === 2 ? authorId : otherId));
  const secondPage = Array.from({ length: 100 }, (_, index) => message(300 - index, otherId));
  const thirdPage = [message(200, authorId, 19), message(199, otherId), message(198, authorId, 3)];
  const harness = createHarness(standardHandler([firstPage, secondPage, thirdPage, []]));
  const preview = await harness.wiper.preview(harness.config);
  assert.equal(preview.phase, "ready");
  assert.equal(preview.scanned, 203);
  assert.equal(preview.matched, 2);
  assert.equal(preview.skipped, 1);
  assert.equal(preview.authorId, authorId);
  assert.ok(!harness.requests.some(request => request.method === "DELETE"));
  assert.ok(!JSON.stringify(preview).includes(testToken));
  assert.ok(!JSON.stringify(preview).includes("content"));
  const scans = harness.requests.filter(request => request.url.searchParams.has("limit"));
  assert.deepEqual(scans.map(request => request.url.searchParams.get("before")), [null, message(301).id, message(201).id, message(198).id]);
  await harness.wiper.deletePreview({ channelId, acceptRisk: true });
  const deletions = harness.requests.filter(request => request.method === "DELETE");
  assert.deepEqual(deletions.map(request => request.url.pathname.split("/").at(-1)), [message(398).id, message(200).id]);
  assert.equal(harness.wiper.state.deleted, 2);
  assert.equal(harness.wiper.state.phase, "complete");
});

test("snapshot requires both explicit consent and an exact matching channel", async () => {
  const harness = createHarness(standardHandler([[message(1)], []]));
  assert.throws(() => harness.wiper.deletePreview({ channelId, acceptRisk: true }), /complete preview/);
  await harness.wiper.preview(harness.config);
  assert.throws(() => harness.wiper.deletePreview({ channelId, acceptRisk: false }), /Confirm the exact/);
  assert.throws(() => harness.wiper.deletePreview({ channelId: otherId, acceptRisk: true }), /Confirm the exact/);
  assert.throws(() => harness.wiper.preview(harness.config), /Stop the current session/);
  assert.ok(!harness.requests.some(request => request.method === "DELETE"));
  await harness.wiper.stop();
});

test("author identity is revalidated immediately before deletion", async () => {
  let selfCalls = 0;
  const fallback = standardHandler([[message(1)], []]);
  const harness = createHarness(request => request.url.pathname.endsWith("users/@me") ?
    jsonResponse({ id: ++selfCalls === 1 ? authorId : otherId }) : fallback(request));
  await harness.wiper.preview(harness.config);
  await assert.rejects(harness.wiper.deletePreview({ channelId, acceptRisk: true }), /account changed/);
  assert.equal(harness.wiper.state.phase, "error");
  assert.ok(!harness.requests.some(request => request.method === "DELETE"));
});

test("webhook messages, other authors and unsupported types are excluded", async () => {
  const webhook = { ...message(4), webhook_id: otherId };
  const harness = createHarness(standardHandler([[webhook, message(3, otherId), message(2, authorId, 999), message(1)], []]));
  await harness.wiper.preview(harness.config);
  assert.equal(harness.wiper.state.matched, 1);
  assert.equal(harness.wiper.state.skipped, 1);
  await harness.wiper.deletePreview({ channelId, acceptRisk: true });
  assert.equal(harness.wiper.state.deleted, 1);
});

for (const scenario of [
  { name: "channel mismatch", pages: [[{ ...message(1), channel_id: otherId }]] },
  { name: "duplicate IDs", pages: [[message(1), message(1)]] },
  { name: "non-decreasing pagination", pages: [[message(2)], [message(2)]] },
  { name: "missing author", pages: [[{ ...message(1), author: {} }]] },
  { name: "non-array page", pages: [{ error: "unexpected" }] }
]) {
  test(`invalid page stops safely: ${scenario.name}`, async () => {
    const harness = createHarness(standardHandler(scenario.pages));
    await assert.rejects(harness.wiper.preview(harness.config));
    assert.equal(harness.wiper.state.phase, "error");
    assert.ok(!harness.requests.some(request => request.method === "DELETE"));
    assert.throws(() => harness.wiper.deletePreview({ channelId, acceptRisk: true }), /complete preview/);
  });
}

test("BigInt pagination preserves snowflake precision beyond Number's safe integer range", async () => {
  const harness = createHarness(standardHandler([[message(2), message(1)], []]));
  await harness.wiper.preview(harness.config);
  assert.equal(harness.requests.at(-1).url.searchParams.get("before"), message(1).id);
  await harness.wiper.stop();
});

test("memory cap stops an oversized preview without offering partial deletion", async () => {
  const harness = createHarness(standardHandler([[message(3), message(2), message(1)]]), { maxCandidates: 2 });
  await assert.rejects(harness.wiper.preview(harness.config), /exceeded 2 eligible/);
  assert.equal(harness.wiper.state.phase, "error");
  assert.throws(() => harness.wiper.deletePreview({ channelId, acceptRisk: true }));
});

test("empty history finishes and never makes a deletion request", async () => {
  const harness = createHarness(standardHandler([[]]));
  await harness.wiper.preview(harness.config);
  assert.equal(harness.wiper.state.phase, "complete");
  assert.equal(harness.requests.length, 3);
});

test("pause lets an in-flight preview finish but prevents the next request until Resume", async () => {
  const pageStarted = deferred();
  const releasePage = deferred();
  const fallback = standardHandler([[]]);
  let firstPage = true;
  const harness = createHarness(async request => {
    if (request.url.searchParams.has("limit") && firstPage) {
      firstPage = false;
      pageStarted.resolve();
      await releasePage.promise;
      return jsonResponse([message(1)]);
    }
    return fallback(request);
  });
  const task = harness.wiper.preview(harness.config);
  await pageStarted.promise;
  harness.wiper.pause();
  releasePage.resolve();
  await nextTurn();
  assert.equal(harness.requests.length, 3);
  assert.equal(harness.wiper.state.paused, true);
  harness.wiper.resume();
  await task;
  assert.equal(harness.wiper.state.phase, "ready");
  await harness.wiper.stop();
});

test("Stop aborts in-flight fetch and releases a paused checkpoint", async () => {
  const fetchStarted = deferred();
  const harness = createHarness(request => new Promise((resolve, reject) => {
    fetchStarted.resolve();
    request.options.signal.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
  }));
  const task = harness.wiper.preview(harness.config);
  const rejected = assert.rejects(task, { name: "AbortError" });
  await fetchStarted.promise;
  harness.wiper.pause();
  await harness.wiper.stop();
  await rejected;
  assert.equal(harness.wiper.state.phase, "stopped");
  assert.equal(harness.requests.length, 1);
});

test("429 during deletion retries exactly one snapshot message without double-counting", async () => {
  let deleteCalls = 0;
  const harness = createHarness(standardHandler([[message(1)], []], () => ++deleteCalls === 1 ?
    jsonResponse({ retry_after: 2 }, 429, { "Retry-After": "3" }) : jsonResponse(null, 204)));
  await harness.wiper.preview(harness.config);
  await harness.wiper.deletePreview({ channelId, acceptRisk: true });
  assert.equal(harness.wiper.state.deleted, 1);
  assert.equal(harness.wiper.state.rateLimits, 1);
  const deletes = harness.requests.filter(request => request.method === "DELETE");
  assert.equal(deletes[0].url.href, deletes[1].url.href);
  assert.ok(deletes[1].time - deletes[0].time >= 3250);
});

test("404 unknown-message continues; 403 stops remaining snapshot deletions", async () => {
  let deleteCalls = 0;
  const harness = createHarness(standardHandler([[message(3), message(2), message(1)], []], () =>
    ++deleteCalls === 1 ? jsonResponse({ code: 10008 }, 404) : jsonResponse({}, 403)));
  await harness.wiper.preview(harness.config);
  await assert.rejects(harness.wiper.deletePreview({ channelId, acceptRisk: true }), /denied access/);
  assert.equal(deleteCalls, 2);
  assert.equal(harness.wiper.state.alreadyGone, 1);
  assert.equal(harness.wiper.state.deleted, 0);
});

test("untrusted exception text cannot leak into public state or logs", async () => {
  const harness = createHarness(() => { throw new Error(testToken); });
  await assert.rejects(harness.wiper.preview(harness.config));
  assert.ok(!JSON.stringify(harness.wiper.state).includes(testToken));
  assert.ok(!JSON.stringify(harness.logs).includes(testToken));
});
