import assert from "node:assert/strict";
import test from "node:test";
import { compileFilters, describeFilters, matchesFilters, maxWordQueries, maxWordInputLength } from "../extension/core/filters.js";
import { datedMessage, message, createHarness, historyHandler, channelId } from "./helpers.js";

const words = { wordEnabled: true, wordMode: "containing", wordQuery: "cat\nblue sky" };
const media = { attachmentEnabled: true, attachmentMode: "containing", attachmentType: "image" };

test("all new filters default off and unused fields do not select anything", () => {
  const filters = compileFilters({ attachmentMode: "invalid", attachmentType: "invalid", wordMatch: "invalid", wholeWords: true });
  assert.equal(filters.keepPinned, false);
  assert.equal(filters.attachmentEnabled, false);
  assert.equal(filters.wholeWords, false);
  assert.equal(matchesFilters({}, filters), true);
});

for (const wordMode of ["containing", "excluding"]) {
  for (const wordMatch of ["any", "all"]) {
    test(`${wordMode} with Match ${wordMatch} applies the complete multiple-term rule`, () => {
      const filters = compileFilters({ ...words, wordMode, wordMatch });
      const cases = [["CAT below the BLUE SKY", true, true], ["cat alone", true, false], ["blue sky", true, false], ["unrelated", false, false], ["", false, false]];
      for (const [content, any, all] of cases) {
        const contains = wordMatch === "all" ? all : any;
        assert.equal(matchesFilters({ content }, filters), wordMode === "containing" ? contains : !contains, content);
      }
    });
  }
}

test("multiline rules trim, ignore blank lines, deduplicate case, and freeze the copied terms", () => {
  const input = { ...words, wordQuery: "  Cat \r\n\r\n BLUE SKY\rcat\n  " };
  const filters = compileFilters(input);
  input.wordQuery = "replacement";
  assert.deepEqual(filters.foldedQueries, ["cat", "blue sky"]);
  assert.ok(Object.isFrozen(filters.queries));
  assert.ok(Object.isFrozen(filters.foldedQueries));
  assert.throws(() => filters.queries.push("replacement"));
  assert.equal(matchesFilters({ content: "blue sky" }, filters), true);
  assert.ok(!describeFilters(filters).includes("BLUE SKY"));
  assert.equal(matchesFilters({ content: "red" }, compileFilters({ ...words, wordQuery: "red,blue" })), false);
});

test("whole words handle phrases, punctuation, Unicode, combining marks, and literal syntax", () => {
  const filters = compileFilters({ ...words, wholeWords: true });
  for (const content of ["(CAT)!", "cat,", "a blue sky!", "catfish then cat", "🐱cat🦊"]) assert.equal(matchesFilters({ content }, filters), true, content);
  for (const content of ["cats", "bobcat", "cat_1", "1cat", "écat", "cat\u0301", "blue skies", "blue skyline"]) assert.equal(matchesFilters({ content }, filters), false, content);
  const unicode = compileFilters({ ...words, wordQuery: "猫\ncafé", wholeWords: true });
  assert.equal(matchesFilters({ content: "猫!" }, unicode), true);
  assert.equal(matchesFilters({ content: "猫咪" }, unicode), false);
  assert.equal(matchesFilters({ content: "CAFÉ." }, unicode), true);
  const literal = compileFilters({ ...words, wordQuery: "[a-z].*", wholeWords: true });
  assert.equal(matchesFilters({ content: " [a-z].* " }, literal), true);
  assert.equal(matchesFilters({ content: "alphabet" }, literal), false);
});

test("multiple-term limits and invalid new flags fail before any requests", () => {
  const badValues = [{ keepPinned: "true" }, { attachmentEnabled: 1 }, { wholeWords: "yes" },
    { ...words, wordMatch: "none" }, { ...words, wordQuery: Array(maxWordQueries + 1).fill("cat").join("\n") },
    { ...words, wordQuery: "x".repeat(maxWordInputLength + 1) }, { ...media, attachmentType: "embeds" },
    { ...media, attachmentMode: "keep" }];
  for (const filters of badValues) {
    const harness = createHarness(() => { throw new Error("Must not fetch"); });
    assert.throws(() => harness.wiper.preview({ ...harness.config, filters }));
    assert.equal(harness.requests.length, 0);
  }
  const filters = compileFilters({ ...words, wordQuery: Array.from({ length: maxWordQueries }, (_, index) => `term${index}`).join("\n") });
  assert.equal(filters.queries.length, maxWordQueries);
});

test("attachment categories support MIME types, filename fallback, and mixed attachments", () => {
  const samples = [[{ filename: "picture.bin", content_type: "IMAGE/PNG" }, "image"],
    [{ filename: "clip.MP4" }, "video"], [{ filename: "voice.ogg", content_type: "audio/ogg" }, "audio"],
    [{ filename: "photo.JPEG", content_type: "application/octet-stream" }, "image"],
    [{ filename: "report.pdf" }, "file"], [{ filename: "README" }, "file"],
    [{ filename: "misleading.jpg", content_type: "video/mp4" }, "video"]];
  for (const [attachment, kind] of samples) {
    for (const attachmentType of ["any", "image", "video", "audio", "file"]) {
      for (const attachmentMode of ["containing", "excluding"]) {
        const filters = compileFilters({ ...media, attachmentType, attachmentMode });
        const contains = attachmentType === "any" || attachmentType === kind;
        assert.equal(matchesFilters({ attachments: [attachment] }, filters), attachmentMode === "containing" ? contains : !contains);
      }
    }
  }
  const mixed = { attachments: [{ filename: "picture.png" }, { filename: "document.pdf" }] };
  assert.equal(matchesFilters(mixed, compileFilters(media)), true);
  assert.equal(matchesFilters(mixed, compileFilters({ ...media, attachmentType: "file" })), true);
  assert.equal(matchesFilters(mixed, compileFilters({ ...media, attachmentMode: "excluding" })), false);
});

test("no attachments pass Excluding and embeds never count as attachments", () => {
  for (const attachmentType of ["any", "image", "video", "audio", "file"]) {
    const input = { attachments: [], embeds: [{ image: { url: "https://example.invalid/photo.png" } }] };
    assert.equal(matchesFilters(input, compileFilters({ ...media, attachmentType })), false);
    assert.equal(matchesFilters(input, compileFilters({ ...media, attachmentType, attachmentMode: "excluding" })), true);
  }
});

test("unknown pin or attachment metadata rejects a preview and cannot reveal filenames", async () => {
  const malformed = [{ pinned: undefined }, { pinned: "false" }, { attachments: undefined }, { attachments: null },
    { attachments: [null] }, { attachments: [{ filename: "" }] },
    { attachments: [{ filename: "private-name.png", content_type: 12 }] }];
  for (const value of malformed) {
    const filters = "pinned" in value ? { keepPinned: true } : { ...media, attachmentMode: "excluding" };
    const harness = createHarness(historyHandler([message(2), { ...message(1), ...value }]));
    await assert.rejects(harness.wiper.preview({ ...harness.config, filters }), error => !error.message.includes("private-name"));
    assert.equal(harness.wiper.state.phase, "error");
    assert.throws(() => harness.wiper.deletePreview({ channelId, acceptRisk: true }));
    assert.ok(harness.requests.every(request => request.method === "GET"));
  }
});

test("date, words, pin protection, and attachments all combine with AND", () => {
  const filters = compileFilters({ dateEnabled: true, dateMode: "during", dateFrom: "2026-10-02", dateTo: "2026-10-02",
    ...words, wordMatch: "all", wholeWords: true, keepPinned: true, ...media });
  const eligible = { ...datedMessage(filters.startTime, "cat under a blue sky"), attachments: [{ filename: "private-photo.png" }] };
  assert.equal(matchesFilters(eligible, filters), true);
  for (const change of [{ pinned: true }, { attachments: [] }, { content: "catfish under a blue sky" },
    { id: datedMessage(filters.startTime - 1).id }]) assert.equal(matchesFilters({ ...eligible, ...change }, filters), false);
});
