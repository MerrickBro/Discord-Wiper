import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { compileFilters, describeFilters, matchesFilters, maxWordQueryLength } from "../extension/core/filters.js";
import { authorId, otherId, channelId, testToken, datedMessage, message, createHarness, standardHandler } from "./helpers.js";

const dateOptions = { dateEnabled: true, dateMode: "during", dateFrom: "2026-10-02", dateTo: "2026-10-04" };
const wordOptions = { wordEnabled: true, wordMode: "containing", wordQuery: "secret phrase" };

test("date and word filters are off by default and ignore unused field values", () => {
  const filters = compileFilters({ dateEnabled: false, dateMode: "invalid", dateFrom: "not a date",
    wordEnabled: false, wordMode: "invalid", wordQuery: "" });
  assert.equal(filters.dateEnabled, false);
  assert.equal(filters.wordEnabled, false);
  assert.equal(matchesFilters({}, filters), true);
  assert.equal(describeFilters(filters), "Date and word filters off.");
  assert.ok(Object.isFrozen(filters));
});

for (const mode of ["before", "after", "during", "except"]) {
  test(`${mode} date filter has precise whole-day boundaries`, () => {
    const filters = compileFilters({ ...dateOptions, dateMode: mode });
    const firstDay = compileFilters({ ...dateOptions, dateMode: "during", dateTo: dateOptions.dateFrom });
    const end = ["before", "after"].includes(mode) ? firstDay.endTime : filters.endTime;
    const times = [filters.startTime - 1, filters.startTime, end - 1, end];
    const expected = {
      before: [true, false, false, false], after: [false, false, false, true],
      during: [false, true, true, false], except: [true, false, false, true]
    };
    assert.deepEqual(times.map(time => matchesFilters(datedMessage(time), filters)), expected[mode]);
    assert.ok(describeFilters(filters).includes(filters.timeZone));
  });
}

test("a single-day During/Except range includes every millisecond of that day", () => {
  const during = compileFilters({ ...dateOptions, dateTo: dateOptions.dateFrom });
  const except = compileFilters({ ...dateOptions, dateMode: "except", dateTo: dateOptions.dateFrom });
  for (const time of [during.startTime, during.startTime + 1000, during.endTime - 1]) {
    assert.equal(matchesFilters(datedMessage(time), during), true);
    assert.equal(matchesFilters(datedMessage(time), except), false);
  }
});

test("local date bounds handle short/long daylight-saving days and non-hour offsets", () => {
  const moduleUrl = new URL("../extension/core/filters.js", import.meta.url).href;
  for (const [timeZone, dateFrom, hours, expectedStart] of [
    ["America/New_York", "2026-03-08", 23, "2026-03-08T05:00:00.000Z"],
    ["America/New_York", "2026-11-01", 25, "2026-11-01T04:00:00.000Z"],
    ["Asia/Kolkata", "2026-10-04", 24, "2026-10-03T18:30:00.000Z"]
  ]) {
    const script = `import { compileFilters } from ${JSON.stringify(moduleUrl)};
      const filters = compileFilters({ dateEnabled: true, dateMode: "during", dateFrom: ${JSON.stringify(dateFrom)}, dateTo: ${JSON.stringify(dateFrom)} });
      console.log(JSON.stringify({ start: new Date(filters.startTime).toISOString(), hours: (filters.endTime - filters.startTime) / 3600000 }));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TZ: timeZone }, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { start: expectedStart, hours });
  }
});

test("calendar validation accepts leap days and rejects invalid/empty/reversed ranges", () => {
  assert.doesNotThrow(() => compileFilters({ ...dateOptions, dateFrom: "2024-02-29" }));
  for (const dateFrom of ["", "2026-02-29", "2026-04-31", "2026-13-01", "2026-00-01", "0000-01-01", "10/04/2026", "2026-1-1", "2026-10-04T00:00:00Z"]) {
    assert.throws(() => compileFilters({ ...dateOptions, dateFrom }), /valid.*date/);
  }
  assert.throws(() => compileFilters({ ...dateOptions, dateTo: "" }), /valid date/);
  assert.throws(() => compileFilters({ ...dateOptions, dateTo: "2026-10-01" }), /on or after/);
});

test("containing/excluding search case-insensitive literal substrings and phrases", () => {
  const containing = compileFilters({ ...wordOptions, wordQuery: "  SeCrEt PhRaSe  " });
  const excluding = compileFilters({ ...wordOptions, wordMode: "excluding" });
  for (const [content, contains] of [["A SECRET phrase here", true], ["secret phrases", true], ["secret\nphrase", false], ["unrelated", false], ["", false]]) {
    assert.equal(matchesFilters({ content }, containing), contains);
    assert.equal(matchesFilters({ content }, excluding), !contains);
  }
  const literal = compileFilters({ ...wordOptions, wordQuery: "[a-z].*" });
  assert.equal(matchesFilters({ content: "alphabet" }, literal), false);
  assert.equal(matchesFilters({ content: "literal [a-z].* text" }, literal), true);
  assert.equal(matchesFilters({ content: "", attachments: [{ filename: "secret phrase.png" }], embeds: [{ title: "secret phrase" }] }, containing), false);
  assert.equal(containing.wordQuery, "SeCrEt PhRaSe");
  assert.ok(!describeFilters(containing).includes(containing.wordQuery));
});

test("invalid filter flags, modes and empty/oversized words fail closed", () => {
  for (const values of [null, [], "all", { dateEnabled: "true" }, { wordEnabled: 1 },
    { ...dateOptions, dateMode: "anything" }, { ...wordOptions, wordMode: "anything" },
    { ...wordOptions, wordQuery: "   " }, { ...wordOptions, wordQuery: "x".repeat(maxWordQueryLength + 1) },
    { ...wordOptions, wordQuery: {} }]) assert.throws(() => compileFilters(values));
  assert.doesNotThrow(() => compileFilters({ ...wordOptions, wordQuery: "x".repeat(maxWordQueryLength) }));
});

test("date and word constraints combine with AND, not OR", () => {
  const filters = compileFilters({ ...dateOptions, ...wordOptions });
  assert.equal(matchesFilters(datedMessage(filters.startTime, "SECRET PHRASE"), filters), true);
  assert.equal(matchesFilters(datedMessage(filters.startTime, "unrelated"), filters), false);
  assert.equal(matchesFilters(datedMessage(filters.startTime - 1, "secret phrase"), filters), false);
  assert.equal(matchesFilters(datedMessage(filters.endTime, "unrelated"), filters), false);
});

test("word filters reject unknown text rather than interpreting it as empty", () => {
  for (const wordMode of ["containing", "excluding"]) {
    const filters = compileFilters({ ...wordOptions, wordMode });
    for (const content of [undefined, null, 123, {}]) assert.throws(() => matchesFilters({ content }, filters), /verify.*text/);
  }
});

test("invalid snowflakes cannot be interpreted as dates", () => {
  const filters = compileFilters(dateOptions);
  for (const id of [undefined, "invalid", "99999999999999999999"]) assert.throws(() => matchesFilters({ id }, filters), /creation date/);
});

test("invalid filters stop before account, channel, or message API requests", () => {
  for (const filters of [{ ...dateOptions, dateTo: "" }, { ...wordOptions, wordQuery: "" }, { wordEnabled: "true" }]) {
    const harness = createHarness(standardHandler([[]]));
    assert.throws(() => harness.wiper.preview({ ...harness.config, filters }));
    assert.deepEqual(harness.requests, []);
    assert.equal(harness.wiper.state.phase, "idle");
  }
});

test("filtered pages never truncate the scan and only matching own messages are deleted", async () => {
  const compiled = compileFilters({ ...dateOptions, ...wordOptions });
  const firstPage = Array.from({ length: 100 }, (_, index) => datedMessage(compiled.endTime + 1000 - index, "secret phrase"));
  const matching = datedMessage(compiled.startTime + 5000, "SECRET PHRASE");
  const secondPage = [datedMessage(compiled.startTime + 6000, "secret phrase", otherId), matching,
    { ...datedMessage(compiled.startTime + 4000, "secret phrase"), webhook_id: otherId },
    datedMessage(compiled.startTime + 3000, "unrelated"), datedMessage(compiled.startTime + 2000, "secret phrase", authorId, 3)];
  const harness = createHarness(standardHandler([firstPage, secondPage, []]));
  const preview = await harness.wiper.preview({ ...harness.config, filters: { ...dateOptions, ...wordOptions } });
  assert.equal(preview.scanned, 105);
  assert.equal(preview.matched, 1);
  assert.equal(preview.filtered, 101);
  assert.equal(preview.skipped, 1);
  assert.equal(preview.filtersActive, true);
  assert.equal(harness.requests.filter(request => request.url.searchParams.has("limit")).length, 3);
  assert.ok(!harness.requests.some(request => request.method === "DELETE"));
  assert.ok(!JSON.stringify(harness.changes).includes("SECRET PHRASE"));
  assert.ok(!JSON.stringify(harness.logs).includes(wordOptions.wordQuery));
  await harness.wiper.deletePreview({ channelId, acceptRisk: true });
  assert.deepEqual(harness.requests.filter(request => request.method === "DELETE").map(request => request.url.pathname.split("/").at(-1)), [matching.id]);
});

test("Except and Excluding together protect the selected dates and phrase", async () => {
  const filters = { ...dateOptions, dateMode: "except", ...wordOptions, wordMode: "excluding" };
  const compiled = compileFilters(filters);
  const outsideUnrelated = datedMessage(compiled.endTime + 3000, "ordinary text");
  const pages = [[outsideUnrelated, datedMessage(compiled.endTime + 2000, "secret phrase"),
    datedMessage(compiled.startTime + 1000, "ordinary text"), datedMessage(compiled.startTime - 1, "SECRET PHRASE")], []];
  const harness = createHarness(standardHandler(pages));
  await harness.wiper.preview({ ...harness.config, filters });
  assert.equal(harness.wiper.state.matched, 1);
  assert.equal(harness.wiper.state.filtered, 3);
  await harness.wiper.deletePreview({ channelId, acceptRisk: true });
  assert.deepEqual(harness.requests.filter(request => request.method === "DELETE").map(request => request.url.pathname.split("/").at(-1)), [outsideUnrelated.id]);
});

test("compiled filters and eligible IDs remain frozen if caller options or text change", async () => {
  const filters = { ...wordOptions };
  const original = { ...message(2), content: "secret phrase" };
  const harness = createHarness(standardHandler([[original, { ...message(1), content: "ordinary text" }], []]));
  const preview = harness.wiper.preview({ ...harness.config, filters });
  filters.wordMode = "excluding";
  filters.wordQuery = "different";
  filters.wordEnabled = false;
  await preview;
  original.content = "edited after preview";
  assert.equal(harness.wiper.state.matched, 1);
  await harness.wiper.deletePreview({ channelId, acceptRisk: true });
  assert.deepEqual(harness.requests.filter(request => request.method === "DELETE").map(request => request.url.pathname.split("/").at(-1)), [original.id]);
});

test("a malformed filtered message discards an earlier partial match", async () => {
  const harness = createHarness(standardHandler([[{ ...message(2), content: "secret phrase" }, { ...message(1), content: null }]]));
  await assert.rejects(harness.wiper.preview({ ...harness.config, filters: wordOptions }), /verify.*text/);
  assert.equal(harness.wiper.state.phase, "error");
  assert.throws(() => harness.wiper.deletePreview({ channelId, acceptRisk: true }), /complete preview/);
  assert.ok(!harness.requests.some(request => request.method === "DELETE"));
  assert.ok(!JSON.stringify(harness.changes).includes(testToken));
});

test("no matches finishes safely and new unfiltered previews retain original behavior", async () => {
  const harness = createHarness(standardHandler([[message(2)], [], [message(1)], []]));
  await harness.wiper.preview({ ...harness.config, filters: wordOptions });
  assert.equal(harness.wiper.state.phase, "complete");
  assert.equal(harness.wiper.state.filtered, 1);
  assert.equal(harness.wiper.state.matched, 0);
  assert.throws(() => harness.wiper.deletePreview({ channelId, acceptRisk: true }));
  await harness.wiper.preview(harness.config);
  assert.equal(harness.wiper.state.filtered, 0);
  assert.equal(harness.wiper.state.filtersActive, false);
  assert.equal(harness.wiper.state.matched, 1);
  await harness.wiper.stop();
});
