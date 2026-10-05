import assert from "node:assert/strict";
import test from "node:test";
import { compileFilters, matchesFilters } from "../extension/core/filters.js";
import { dateScanRanges } from "../extension/core/dateScan.js";
import { channelId, datedMessage, message, createHarness, historyHandler, standardHandler, jsonResponse } from "./helpers.js";

const options = { dateEnabled: true, dateMode: "during", dateFrom: "2026-10-02", dateTo: "2026-10-04" };
const pageRequests = harness => harness.requests.filter(request => request.url.searchParams.has("limit"));
const deletedIds = harness => harness.requests.filter(request => request.method === "DELETE").map(request => request.url.pathname.split("/").at(-1));

test("scan cursors are exact exclusive snowflake bounds without losing low bits", () => {
  const filters = compileFilters(options);
  const boundary = milliseconds => String((BigInt(milliseconds) - 1420070400000n) << 22n);
  const ranges = dateScanRanges(filters);
  assert.deepEqual(ranges, [{ lowerId: boundary(filters.startTime), before: boundary(filters.endTime) }]);
  assert.ok(Object.isFrozen(ranges));
  assert.ok(Object.isFrozen(ranges[0]));
  assert.deepEqual(dateScanRanges(compileFilters()), [{ lowerId: "", before: "" }]);
});

for (const dateMode of ["before", "after", "during", "except"]) {
  test(`${dateMode} skips unrelated pages while selecting the same IDs as a full scan`, async () => {
    const filters = { ...options, dateMode };
    const compiled = compileFilters(filters);
    const messages = [
      ...Array.from({ length: 301 }, (_, index) => datedMessage(compiled.endTime + 10000 - index, "recent")),
      ...Array.from({ length: 601 }, (_, index) => datedMessage(compiled.startTime + 10000 - index, "inside")),
      ...Array.from({ length: 301 }, (_, index) => datedMessage(compiled.startTime - 10000 - index, "old"))
    ];
    const expected = messages.filter(value => matchesFilters(value, compiled)).map(value => value.id);
    const harness = createHarness(historyHandler(messages));
    await harness.wiper.preview({ ...harness.config, filters });
    assert.equal(harness.wiper.state.dateOptimized, true);
    assert.equal(harness.wiper.state.matched, expected.length);
    assert.ok(pageRequests(harness).length < Math.ceil(messages.length / 100) + 1);
    assert.equal(harness.requests.some(request => request.method === "DELETE"), false);
    await harness.wiper.deletePreview({ channelId, acceptRisk: true });
    assert.deepEqual(deletedIds(harness), expected);
  });
}

test("Except boundary pages may include old matches without duplicating or omitting them", async () => {
  const filters = { ...options, dateMode: "except" };
  const compiled = compileFilters(filters);
  const messages = [
    ...Array.from({ length: 30 }, (_, index) => datedMessage(compiled.endTime + 1000 - index)),
    ...Array.from({ length: 20 }, (_, index) => datedMessage(compiled.startTime + 1000 - index)),
    ...Array.from({ length: 80 }, (_, index) => datedMessage(compiled.startTime - 1000 - index))
  ];
  const harness = createHarness(historyHandler(messages));
  await harness.wiper.preview({ ...harness.config, filters });
  const requests = pageRequests(harness);
  assert.equal(requests[1].url.searchParams.get("before"), messages[99].id);
  assert.equal(harness.wiper.state.scanned, 130);
  assert.equal(harness.wiper.state.matched, 110);
  await harness.wiper.deletePreview({ channelId, acceptRisk: true });
  assert.deepEqual(deletedIds(harness), messages.filter(value => matchesFilters(value, compiled)).map(value => value.id));
  assert.equal(new Set(deletedIds(harness)).size, 110);
});

test("all snowflake low-bit values on midnight obey both exact date boundaries", async () => {
  const compiled = compileFilters(options);
  const at = (time, low) => ({ ...message(1), id: String(((BigInt(time) - 1420070400000n) << 22n) + low) });
  const messages = [at(compiled.endTime, 4194303n), at(compiled.endTime, 0n), at(compiled.endTime - 1, 4194303n),
    at(compiled.startTime, 4194303n), at(compiled.startTime, 0n), at(compiled.startTime - 1, 4194303n)];
  const harness = createHarness(historyHandler(messages));
  await harness.wiper.preview({ ...harness.config, filters: options });
  assert.equal(harness.wiper.state.matched, 3);
  await harness.wiper.deletePreview({ channelId, acceptRisk: true });
  assert.deepEqual(deletedIds(harness), messages.slice(2, 5).map(value => value.id));
});

test("short pages and pages with only nonmatching words do not end a date scan", async () => {
  const compiled = compileFilters(options);
  const messages = Array.from({ length: 7 }, (_, index) => datedMessage(compiled.startTime + 1000 - index, index === 6 ? "target" : "other"));
  const handler = historyHandler(messages);
  const harness = createHarness(async request => {
    const response = handler(request);
    return request.url.searchParams.has("limit") ? jsonResponse((await response.json()).slice(0, 2)) : response;
  });
  await harness.wiper.preview({ ...harness.config, filters: { ...options, wordEnabled: true, wordMode: "containing", wordQuery: "target" } });
  assert.equal(harness.wiper.state.scanned, 7);
  assert.equal(harness.wiper.state.matched, 1);
  assert.equal(pageRequests(harness).length, 5);
  await harness.wiper.stop();
});

test("dates outside the 64-bit timestamp range clamp without invalid API cursors", async () => {
  for (const filters of [{ ...options, dateMode: "before", dateFrom: "2010-01-01" },
    { ...options, dateFrom: "2010-01-01", dateTo: "2010-01-02" },
    { ...options, dateMode: "after", dateFrom: "9999-01-01" }]) {
    const harness = createHarness(historyHandler([message(1)]));
    const state = await harness.wiper.preview({ ...harness.config, filters });
    assert.equal(state.phase, "complete");
    assert.equal(state.matched, 0);
    assert.equal(harness.requests.length, 2);
    assert.equal(pageRequests(harness).length, 0);
  }
  assert.deepEqual(dateScanRanges(compileFilters({ ...options, dateMode: "after", dateFrom: "2010-01-01" })), [{ lowerId: "", before: "" }]);
  assert.deepEqual(dateScanRanges(compileFilters({ ...options, dateMode: "before", dateFrom: "9999-01-01" })), [{ lowerId: "", before: "" }]);
});

test("optimized scans reject ascending or out-of-bound API pages without a usable preview", async () => {
  const compiled = compileFilters(options);
  for (const page of [[datedMessage(compiled.startTime + 1), datedMessage(compiled.startTime + 2)],
    [datedMessage(compiled.endTime)], [datedMessage(compiled.startTime), datedMessage(compiled.startTime)]]) {
    const harness = createHarness(standardHandler([page]));
    await assert.rejects(harness.wiper.preview({ ...harness.config, filters: options }), /pagination/);
    assert.equal(harness.wiper.state.phase, "error");
    assert.throws(() => harness.wiper.deletePreview({ channelId, acceptRisk: true }));
    assert.equal(harness.requests.some(request => request.method === "DELETE"), false);
  }
});
