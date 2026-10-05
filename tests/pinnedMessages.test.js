import assert from "node:assert/strict";
import test from "node:test";
import { channelId, authorId, otherId, message, createHarness, historyHandler, jsonResponse, deferred, nextTurn } from "./helpers.js";

const messagePath = id => `/api/v10/channels/${channelId}/messages/${id}`;
const specificGets = harness => harness.requests.filter(request => request.method === "GET" && request.url.pathname.startsWith(`/api/v10/channels/${channelId}/messages/`));
const deletes = harness => harness.requests.filter(request => request.method === "DELETE");

test("keep pinned excludes existing pins, preserves late pins, and counts missing messages without DELETE", async () => {
  const messages = [{ ...message(4), pinned: true }, message(3), message(2), message(1)];
  const currentMessage = id => id === message(3).id ? { ...message(3), pinned: true } : id === message(1).id ? null : message(2);
  const harness = createHarness(historyHandler(messages, undefined, currentMessage));
  await harness.wiper.preview({ ...harness.config, filters: { keepPinned: true } });
  assert.equal(harness.wiper.state.matched, 3);
  assert.equal(harness.wiper.state.filtered, 1);
  assert.equal(specificGets(harness).length, 0);
  await harness.wiper.deletePreview({ channelId, acceptRisk: true });
  assert.equal(harness.wiper.state.phase, "complete");
  assert.equal(harness.wiper.state.deleted, 1);
  assert.equal(harness.wiper.state.kept, 1);
  assert.equal(harness.wiper.state.alreadyGone, 1);
  assert.deepEqual(deletes(harness).map(request => request.url.pathname), [messagePath(message(2).id)]);
  assert.deepEqual(specificGets(harness).map(request => request.url.pathname), messages.slice(1).map(value => messagePath(value.id)));
  assert.equal(harness.wiper.state.remainingMs, 0);
});

test("with protection off pins retain the original behavior and no extra reads are made", async () => {
  const harness = createHarness(historyHandler([{ ...message(1), pinned: true }]));
  await harness.wiper.preview(harness.config);
  await harness.wiper.deletePreview({ channelId, acceptRisk: true });
  assert.equal(deletes(harness).length, 1);
  assert.equal(specificGets(harness).length, 0);
});

test("pin checks fail closed on changed ownership, channel, ID, message type, or unreadable pin status", async () => {
  for (const change of [{ id: message(2).id }, { channel_id: otherId }, { author: { id: otherId } },
    { webhook_id: authorId }, { type: 3 }, { pinned: undefined }, { pinned: "false" }]) {
    const harness = createHarness(historyHandler([message(1)], undefined, () => ({ ...message(1), ...change })));
    await harness.wiper.preview({ ...harness.config, filters: { keepPinned: true } });
    await assert.rejects(harness.wiper.deletePreview({ channelId, acceptRisk: true }), /verification failed/);
    assert.equal(harness.wiper.state.phase, "error");
    assert.equal(deletes(harness).length, 0);
  }
});

test("only unknown-message 404 is benign during a pin read; missing channel stops", async () => {
  const gone = createHarness(() => jsonResponse({ code: 10008 }, 404));
  assert.equal(await gone.client.getMessage(channelId, message(1).id), null);
  const handler = historyHandler([message(1)]);
  const harness = createHarness(request => request.url.pathname === messagePath(message(1).id) ? jsonResponse({ code: 10003 }, 404) : handler(request));
  await harness.wiper.preview({ ...harness.config, filters: { keepPinned: true } });
  await assert.rejects(harness.wiper.deletePreview({ channelId, acceptRisk: true }), /HTTP 404/);
  assert.equal(deletes(harness).length, 0);
  assert.equal(specificGets(harness).length, 1);
});

test("Pause during a pin read blocks the following DELETE until Resume", async () => {
  const handler = historyHandler([message(1)]);
  let harness;
  harness = createHarness(request => {
    if (request.method === "GET" && request.url.pathname === messagePath(message(1).id)) harness.wiper.pause();
    return handler(request);
  });
  await harness.wiper.preview({ ...harness.config, filters: { keepPinned: true } });
  const deleting = harness.wiper.deletePreview({ channelId, acceptRisk: true });
  await nextTurn();
  assert.equal(harness.wiper.state.paused, true);
  assert.equal(deletes(harness).length, 0);
  harness.advanceTime(60000);
  harness.wiper.resume();
  await deleting;
  assert.equal(deletes(harness).length, 1);
});

test("Stop during a pin read aborts it and prevents the following DELETE", async () => {
  const started = deferred();
  const response = deferred();
  const handler = historyHandler([message(1)]);
  const harness = createHarness(request => {
    if (request.method === "GET" && request.url.pathname === messagePath(message(1).id)) {
      started.resolve();
      return response.promise;
    }
    return handler(request);
  });
  await harness.wiper.preview({ ...harness.config, filters: { keepPinned: true } });
  const deleting = harness.wiper.deletePreview({ channelId, acceptRisk: true });
  const rejected = assert.rejects(deleting, error => error.name === "AbortError");
  await started.promise;
  const stopping = harness.wiper.stop();
  response.resolve(jsonResponse(message(1)));
  await stopping;
  await rejected;
  assert.equal(harness.wiper.state.phase, "stopped");
  assert.equal(deletes(harness).length, 0);
});

test("finishing the last pin read while paused reports Complete and freezes timing", async () => {
  const handler = historyHandler([message(1)], undefined, () => ({ ...message(1), pinned: true }));
  let harness;
  harness = createHarness(request => {
    if (request.method === "GET" && request.url.pathname === messagePath(message(1).id)) harness.wiper.pause();
    return handler(request);
  });
  await harness.wiper.preview({ ...harness.config, filters: { keepPinned: true } });
  await harness.wiper.deletePreview({ channelId, acceptRisk: true });
  assert.equal(harness.wiper.state.phase, "complete");
  assert.equal(harness.wiper.state.paused, false);
  assert.equal(harness.wiper.state.kept, 1);
  assert.equal(deletes(harness).length, 0);
});

test("pin-read IDs and pagination cursors are validated before network access", async () => {
  const harness = createHarness(() => jsonResponse([]));
  assert.throws(() => harness.client.getMessage(channelId, "../other"), /Invalid message ID/);
  for (const cursor of ["-1", "01", "18446744073709551616", "1.5", "../users", {}]) {
    assert.throws(() => harness.client.getMessages(channelId, cursor), /pagination cursor/);
  }
  assert.equal(harness.requests.length, 0);
  await harness.client.getMessages(channelId, "1");
  assert.equal(harness.requests[0].url.searchParams.get("before"), "1");
});
