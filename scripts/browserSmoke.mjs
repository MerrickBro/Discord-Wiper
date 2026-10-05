import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

let playwright;
try {
  playwright = createRequire(import.meta.url)("playwright");
} catch {
  if (!process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES) throw new Error("Install Playwright first: npm install --no-save playwright");
  playwright = createRequire(`${process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES}/package.json`)("playwright");
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = resolve(process.env.WIPER_EXTENSION_PATH || resolve(projectRoot, "extension"));
const profileDirectory = await mkdtemp(resolve(tmpdir(), "merrick-wiper-test-"));
const channelId = "123456789012345678";
const authorId = "223456789012345678";
const otherId = "323456789012345678";
const testToken = "fictional-browser-test-token-no-account";
const privateContent = "Fictional message content must not be logged or stored.";
const requests = [];
const browserErrors = [];
const unexpectedRequests = [];
let scenario = "normal";
let limitedOnce = false;
let context;

function message(offset, author = authorId, extra = {}) {
  return { id: String(1450000000000000000n + BigInt(offset)), channel_id: channelId,
    author: { id: author }, type: 0, content: privateContent, pinned: false, attachments: [], ...extra };
}

const firstPage = [message(9), message(8, otherId), message(7, authorId, { type: 3 }),
  message(6, authorId, { webhook_id: "523456789012345678" }), message(5)];
const secondPage = [message(4, authorId, { type: 19 })];
const candidates = [message(9).id, message(5).id, message(4).id];
const filterPhrase = "filter phrase";
function datedMessage(timestamp, content) {
  const id = String(((BigInt(Date.parse(timestamp)) - 1420070400000n) << 22n) + 1n);
  return message(1, authorId, { id, content: `${content} · ${privateContent}` });
}
const filterMessages = [datedMessage("2026-10-05T12:00:00Z", filterPhrase),
  datedMessage("2026-10-04T15:00:00Z", "different words"), datedMessage("2026-10-04T12:00:00Z", "FILTER PHRASE"),
  datedMessage("2026-10-03T12:00:00Z", filterPhrase)];
const filteredCandidate = filterMessages[2].id;
const advancedMessages = [
  message(5, authorId, { content: `cat under blue sky · ${privateContent}`, attachments: [{ filename: "private-photo.png" }], pinned: true }),
  message(4, authorId, { content: `cat under blue sky · ${privateContent}`, attachments: [{ filename: "private-photo.png" }] }),
  message(3, authorId, { content: `cats under blue sky · ${privateContent}`, attachments: [{ filename: "private-photo.png" }] }),
  message(2, authorId, { content: `cat under blue sky · ${privateContent}` }),
  message(1, authorId, { content: `cat under blue sky · ${privateContent}`, attachments: [{ filename: "private-photo.png" }] })
];

async function waitForPanel(page) {
  await page.locator("#merrickDiscordWiper").waitFor();
  const viewport = page.viewportSize();
  await page.mouse.click(viewport.width - 115, viewport.height - 36);
  await page.waitForFunction(() => window.frames.length > 0);
  let frame;
  for (let attempt = 0; attempt < 100; attempt++) {
    frame = page.frames().find(candidate => candidate.url().startsWith("chrome-extension://") && candidate.url().includes("/panel.html"));
    if (frame) break;
    await delay(50);
  }
  assert.ok(frame, "The bundled extension iframe must load");
  await frame.waitForFunction(() => !document.getElementById("previewButton").disabled);
  await frame.waitForFunction(expected => document.getElementById("channelInput").value === expected, channelId);
  return frame;
}

async function waitForState(frame, state) {
  await frame.waitForFunction(expected => document.getElementById("statusBadge").dataset.state === expected, state);
}

async function configure(frame) {
  await frame.locator("#tokenInput").fill(testToken);
  await frame.locator("#minDelayInput").fill("1000");
  await frame.locator("#maxDelayInput").fill("1000");
  await frame.locator("#riskInput").check();
}

async function assertPrivateState(frame, remembered = false) {
  const stored = await frame.evaluate(async () => ({
    settings: await chrome.storage.local.get(null),
    localKeys: Object.keys(localStorage),
    token: document.getElementById("tokenInput").value,
    tokenType: document.getElementById("tokenInput").type,
    text: document.body.textContent
  }));
  assert.equal(stored.token, remembered ? testToken : "");
  assert.equal(stored.tokenType, "password");
  assert.deepEqual(stored.localKeys, []);
  if (remembered) assert.equal(stored.settings.wiperSavedToken, testToken);
  else assert.equal("wiperSavedToken" in stored.settings, false);
  const nonCredentialSettings = { ...stored.settings };
  delete nonCredentialSettings.wiperSavedToken;
  assert.ok(!JSON.stringify(nonCredentialSettings).includes(testToken));
  assert.ok(!JSON.stringify(stored.settings).includes(authorId));
  assert.ok(!stored.text.includes(testToken));
  assert.ok(!stored.text.includes(privateContent));
  for (const id of candidates) assert.ok(!JSON.stringify(stored.settings).includes(id));
  return stored.settings;
}

async function capture(page, name) {
  if (!process.env.WIPER_ARTIFACTS_DIR) return;
  await mkdir(process.env.WIPER_ARTIFACTS_DIR, { recursive: true });
  await page.screenshot({ path: resolve(process.env.WIPER_ARTIFACTS_DIR, `${name}.png`) });
}

try {
  context = await playwright.chromium.launchPersistentContext(profileDirectory, {
    channel: "chromium", headless: true, viewport: { width: 1280, height: 900 }, timezoneId: "America/Detroit",
    args: [`--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`, "--disable-background-networking"]
  });
  context.setDefaultTimeout(15000);
  context.on("page", page => page.on("pageerror", error => browserErrors.push(error.message)));
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!/^https?:$/.test(url.protocol)) return route.continue();
    if (["discord.com", "ptb.discord.com", "canary.discord.com"].includes(url.hostname) && url.pathname.startsWith("/channels/")) {
      return route.fulfill({ contentType: "text/html", body: '<!doctype html><html><head><title>Fictional Discord fixture</title></head><body style="margin:0;background:#252932;color:#eee;font:16px sans-serif"><p style="padding:30px">Mock Discord · no account connected</p></body></html>' });
    }
    if (url.origin !== "https://discord.com" || !url.pathname.startsWith("/api/v10/")) {
      unexpectedRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort();
    }
    assert.equal(request.headers().authorization, testToken);
    assert.ok(!url.href.includes(testToken));
    const record = { path: url.pathname, before: url.searchParams.get("before"), method: request.method(), time: Date.now() };
    requests.push(record);
    const reply = (body, status = 200, headers = {}) => route.fulfill({ status,
      contentType: "application/json", headers, body: status === 204 ? "" : JSON.stringify(body) });
    if (scenario === "unauthorized") return reply({ message: testToken }, 401);
    if (record.path === "/api/v10/users/@me") return reply({ id: authorId });
    if (record.path === `/api/v10/channels/${channelId}`) return reply({ id: channelId, type: 1 });
    if (record.method === "GET" && record.path === `/api/v10/channels/${channelId}/messages`) {
      assert.equal(url.searchParams.get("limit"), "100");
      if (scenario === "empty") return reply([]);
      if (["filters", "advanced"].includes(scenario)) {
        const values = scenario === "filters" ? filterMessages : advancedMessages;
        return reply(values.filter(value => !record.before || BigInt(value.id) < BigInt(record.before)).slice(0, 100));
      }
      if (!record.before) return reply(firstPage);
      if (record.before === message(5).id) return reply(secondPage);
      assert.equal(record.before, message(4).id);
      return reply([]);
    }
    if (record.method === "GET" && scenario === "advanced" && record.path.startsWith(`/api/v10/channels/${channelId}/messages/`)) {
      const id = record.path.split("/").at(-1);
      assert.ok([message(4).id, message(1).id].includes(id));
      const current = advancedMessages.find(value => value.id === id);
      return reply({ ...current, pinned: id === message(4).id });
    }
    if (record.method === "DELETE") {
      const id = record.path.split("/").at(-1);
      if (scenario === "advanced") {
        assert.equal(id, message(1).id, "Late pins, substrings, and missing attachments must be preserved");
        return reply(null, 204);
      }
      if (scenario === "filters") {
        assert.equal(id, filteredCandidate, "Only the confirmed date-and-word match may be deleted");
        return reply(null, 204);
      }
      assert.ok(candidates.includes(id), "Only the verified author's eligible snapshot may be deleted");
      if (id === candidates[0] && !limitedOnce) {
        limitedOnce = true;
        return reply({ retry_after: 1.25, global: true }, 429, { "Retry-After": "1.5", "X-RateLimit-Global": "true" });
      }
      return id === candidates[1] ? reply({ code: 10008 }, 404) : reply(null, 204);
    }
    throw new Error(`Unexpected API route: ${record.method} ${record.path}`);
  });

  const page = await context.newPage();
  await page.goto(`https://discord.com/channels/@me/${channelId}`);
  let frame = await waitForPanel(page);
  assert.equal(await frame.locator("#startButton").isDisabled(), true);
  assert.equal(await frame.locator("#timingStats").isVisible(), false);
  for (const id of ["dateFilterInput", "wordFilterInput", "wholeWordsInput", "keepPinnedInput", "attachmentFilterInput"]) {
    assert.equal(await frame.locator(`#${id}`).isChecked(), false);
  }
  assert.equal(await page.evaluate(() => document.getElementById("merrickDiscordWiper").shadowRoot), null);
  await capture(page, "dark-ready");
  await frame.locator("#themeButton").click();
  assert.equal(await frame.locator("html").getAttribute("data-theme"), "light");
  await capture(page, "light-ready");

  await frame.locator("#tokenInput").fill(testToken);
  await frame.locator("#showTokenButton").click();
  assert.equal(await frame.locator("#tokenInput").getAttribute("type"), "text");
  await frame.locator("#previewButton").click();
  await frame.locator("#formError").waitFor();
  assert.match(await frame.locator("#formError").textContent(), /Acknowledge/);
  assert.equal(requests.length, 0);
  await assertPrivateState(frame);

  await configure(frame);
  await frame.locator("#previewButton").click();
  await waitForState(frame, "waiting");
  await frame.locator("#pauseButton").click();
  await waitForState(frame, "paused");
  const pausedCount = requests.length;
  await delay(1100);
  assert.equal(requests.length, pausedCount);

  const secondTab = await context.newPage();
  await secondTab.goto(`https://discord.com/channels/@me/${channelId}`);
  const secondFrame = await waitForPanel(secondTab);
  await configure(secondFrame);
  await secondFrame.locator("#previewButton").click();
  await secondFrame.locator("#formError").waitFor();
  assert.match(await secondFrame.locator("#formError").textContent(), /Another Discord tab/);
  await assertPrivateState(secondFrame);
  assert.equal(requests.length, pausedCount);
  await secondTab.close();
  await page.bringToFront();
  await frame.locator("#pauseButton").click();
  await waitForState(frame, "ready");
  assert.equal(await frame.locator("#scannedCount").textContent(), "6");
  assert.equal(await frame.locator("#matchedCount").textContent(), "3");
  assert.equal(requests.filter(request => request.method === "DELETE").length, 0);
  await assertPrivateState(frame);

  const bridgeId = new URL(frame.url()).searchParams.get("bridgeId");
  await page.evaluate(({ bridgeId, origin }) => window.frames[0].postMessage({ type: "merrickWiperStart", bridgeId, acceptRisk: true }, origin),
    { bridgeId, origin: frame.url().split("/").slice(0, 3).join("/") });
  await delay(100);
  assert.equal(requests.filter(request => request.method === "DELETE").length, 0);

  await frame.locator("#startButton").click();
  await frame.locator("#confirmationInput").fill(otherId);
  await frame.locator("#permanentInput").check();
  assert.equal(await frame.locator("#confirmDeleteButton").isDisabled(), true);
  await page.setViewportSize({ width: 390, height: 800 });
  assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await capture(page, "mobile-confirmation");
  await frame.locator("#cancelConfirmButton").click();
  assert.equal(requests.filter(request => request.method === "DELETE").length, 0);
  await frame.locator("#startButton").click();
  await frame.locator("#confirmationInput").fill(channelId);
  await frame.locator("#permanentInput").check();
  await frame.locator("#confirmDeleteButton").click();
  await frame.waitForFunction(() => document.getElementById("logList").textContent.includes("Global rate limit"));
  await waitForState(frame, "waiting");
  await frame.locator("#pauseButton").click();
  await waitForState(frame, "paused");
  const cooldownCount = requests.length;
  await delay(1900);
  assert.equal(requests.length, cooldownCount);
  await frame.locator("#pauseButton").click();
  await waitForState(frame, "complete");
  assert.equal(await frame.locator("#deletedCount").textContent(), "2");
  assert.equal(await frame.locator("#remainingValue").textContent(), "Complete");
  assert.notEqual(await frame.locator("#speedValue").textContent(), "—");
  const deletes = requests.filter(request => request.method === "DELETE");
  assert.deepEqual(deletes.map(request => request.path.split("/").at(-1)), [candidates[0], ...candidates]);
  assert.ok(deletes[1].time - deletes[0].time >= 1750);
  assert.equal(await frame.locator("#startButton").isDisabled(), true);
  await assertPrivateState(frame);
  console.log("Passed: preview pagination, owner/type filtering, exact confirmation, cooldown, pause/resume, and cross-tab exclusion.");

  await configure(frame);
  await frame.locator("#previewButton").click();
  await waitForState(frame, "waiting");
  await frame.locator("#closeButton").click();
  await waitForState(frame, "paused");
  const hiddenCount = requests.length;
  await delay(1100);
  assert.equal(requests.length, hiddenCount);
  const viewport = page.viewportSize();
  await page.mouse.click(viewport.width - 115, viewport.height - 36);
  await waitForState(frame, "paused");
  await frame.locator("#stopButton").click();
  await waitForState(frame, "stopped");
  await assertPrivateState(frame);
  await delay(1100);
  assert.equal(requests.length, hiddenCount);

  scenario = "unauthorized";
  await configure(frame);
  await frame.locator("#previewButton").click();
  await waitForState(frame, "error");
  assert.equal(requests.length, hiddenCount + 1);
  await assertPrivateState(frame);
  scenario = "empty";
  await configure(frame);
  await frame.locator("#previewButton").click();
  await waitForState(frame, "complete");
  assert.equal(await frame.locator("#matchedCount").textContent(), "0");
  await assertPrivateState(frame);

  await frame.locator("#rememberChannelInput").check();
  await frame.waitForFunction(async expected => (await chrome.storage.local.get("wiperPreferences")).wiperPreferences.channelId === expected, channelId);
  await frame.locator("#tokenInput").fill(testToken);
  await page.reload();
  frame = await waitForPanel(page);
  assert.equal(await frame.locator("#rememberChannelInput").isChecked(), true);
  assert.equal(await frame.locator("#riskInput").isChecked(), false);
  assert.equal(await frame.locator("html").getAttribute("data-theme"), "light");
  await assertPrivateState(frame);
  await frame.locator("#rememberChannelInput").uncheck();
  await frame.waitForFunction(async () => (await chrome.storage.local.get("wiperPreferences")).wiperPreferences.channelId === "");
  const stored = await assertPrivateState(frame);
  assert.deepEqual(Object.keys(stored), ["wiperPreferences"]);
  assert.deepEqual(Object.keys(stored.wiperPreferences).sort(), ["channelId", "maxDelay", "minDelay", "rememberChannel", "theme"]);
  await capture(page, "mobile-ready");

  scenario = "filters";
  assert.equal(await frame.locator("#dateFilterInput").isChecked(), false);
  assert.equal(await frame.locator("#wordFilterInput").isChecked(), false);
  await frame.locator("#filterSection summary").click();
  await frame.locator("#dateFilterInput").check();
  await frame.locator("#dateModeInput").selectOption("during");
  await frame.locator("#dateFromInput").fill("2026-10-04");
  await frame.locator("#dateToInput").fill("2026-10-04");
  await frame.locator("#wordFilterInput").check();
  await frame.locator("#wordModeInput").selectOption("containing");
  await frame.locator("#wordQueryInput").fill(filterPhrase);
  await configure(frame);
  await frame.locator("#speedPresetInput").selectOption("faster");
  const filterRequestStart = requests.length;
  await frame.locator("#previewButton").click();
  await waitForState(frame, "ready");
  assert.equal(await frame.locator("#matchedCount").textContent(), "1");
  assert.match(await frame.locator("#filteredDetail").textContent(), /2 own messages excluded/);
  assert.ok(requests.slice(filterRequestStart).find(request => request.path.endsWith("/messages")).before);
  for (const id of ["dateFilterInput", "dateModeInput", "dateFromInput", "dateToInput", "wordFilterInput", "wordModeInput", "wordQueryInput"]) {
    assert.equal(await frame.locator(`#${id}`).isDisabled(), true);
  }
  assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await capture(page, "mobile-filter-preview");
  await frame.locator("#startButton").click();
  assert.match(await frame.locator("#confirmFilters").textContent(), /during 2026-10-04 through 2026-10-04/);
  assert.match(await frame.locator("#confirmFilters").textContent(), /America\/Detroit/);
  assert.match(await frame.locator("#confirmFilters").textContent(), /filter phrase/);
  await frame.locator("#confirmationInput").fill(channelId);
  await frame.locator("#permanentInput").check();
  await frame.locator("#confirmDeleteButton").click();
  await waitForState(frame, "complete");
  assert.deepEqual(requests.slice(filterRequestStart).filter(request => request.method === "DELETE").map(request => request.path.split("/").at(-1)), [filteredCandidate]);
  const filterSettings = await assertPrivateState(frame);
  assert.ok(!JSON.stringify(filterSettings).includes(filterPhrase));
  assert.ok(!JSON.stringify(filterSettings).includes("dateEnabled"));
  await configure(frame);
  await frame.locator("#dateFromInput").fill("2026-10-05");
  const invalidFilterCount = requests.length;
  await frame.locator("#previewButton").click();
  await frame.locator("#formError").waitFor();
  assert.match(await frame.locator("#formError").textContent(), /on or after/);
  assert.equal(requests.length, invalidFilterCount);
  await frame.locator("#dateFilterInput").uncheck();
  await frame.locator("#wordQueryInput").fill("no matching phrase exists");
  await configure(frame);
  await frame.locator("#previewButton").click();
  await frame.waitForFunction(() => document.getElementById("statusBadge").dataset.state === "complete" &&
    !document.getElementById("previewButton").disabled && document.getElementById("matchedCount").textContent === "0");
  assert.equal(await frame.locator("#startButton").isDisabled(), true);
  assert.equal(requests.slice(invalidFilterCount).some(request => request.method === "DELETE"), false);
  scenario = "advanced";
  await frame.locator("#wordQueryInput").fill("cat\nblue sky");
  await frame.locator("#wordMatchInput").selectOption("all");
  await frame.locator("#wholeWordsInput").check();
  await frame.locator("#keepPinnedInput").check();
  await frame.locator("#attachmentFilterInput").check();
  await frame.locator("#attachmentTypeInput").selectOption("image");
  await configure(frame);
  const advancedStart = requests.length;
  await frame.locator("#previewButton").click();
  await waitForState(frame, "ready");
  assert.equal(await frame.locator("#matchedCount").textContent(), "2");
  for (const id of ["wordMatchInput", "wholeWordsInput", "keepPinnedInput", "attachmentFilterInput", "attachmentTypeInput"]) {
    assert.equal(await frame.locator(`#${id}`).isDisabled(), true);
  }
  assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await capture(page, "mobile-advanced-preview");
  await frame.locator("#startButton").click();
  assert.match(await frame.locator("#confirmFilters").textContent(), /match all of 2 terms, whole words/);
  assert.match(await frame.locator("#confirmFilters").textContent(), /"cat", "blue sky"/);
  await frame.locator("#confirmationInput").fill(channelId);
  await frame.locator("#permanentInput").check();
  await frame.locator("#confirmDeleteButton").click();
  await waitForState(frame, "complete");
  assert.match(await frame.locator("#statusDetail").textContent(), /1 kept after pin checks/);
  assert.deepEqual(requests.slice(advancedStart).filter(request => request.method === "DELETE").map(request => request.path.split("/").at(-1)), [message(1).id]);
  const advancedSettings = await assertPrivateState(frame);
  assert.ok(!JSON.stringify(advancedSettings).includes("blue sky"));
  assert.ok(!JSON.stringify(advancedSettings).includes("attachmentEnabled"));
  const filterReloadCount = requests.length;
  await page.reload();
  frame = await waitForPanel(page);
  assert.equal(await frame.locator("#dateFilterInput").isChecked(), false);
  assert.equal(await frame.locator("#wordFilterInput").isChecked(), false);
  for (const id of ["wholeWordsInput", "keepPinnedInput", "attachmentFilterInput"]) assert.equal(await frame.locator(`#${id}`).isChecked(), false);
  assert.equal(await frame.locator("#wordQueryInput").inputValue(), "");
  assert.equal(requests.length, filterReloadCount);
  scenario = "normal";
  console.log("Passed: default-off filters, optimized dates, multiple whole-word rules, attachment metadata, late pin protection, locked confirmation, private settings, and reload reset.");

  await frame.locator("#speedPresetInput").selectOption("faster");
  assert.equal(await frame.locator("#minDelayInput").inputValue(), "500");
  assert.equal(await frame.locator("#maxDelayInput").inputValue(), "750");
  await frame.locator("#tokenInput").fill(testToken);
  await frame.locator("#rememberTokenInput").check();
  await frame.waitForFunction(async () => (await chrome.storage.local.get("wiperSavedToken")).wiperSavedToken !== undefined);
  await assertPrivateState(frame, true);
  const reloadCount = requests.length;
  await page.reload();
  frame = await waitForPanel(page);
  await assertPrivateState(frame, true);
  assert.equal(await frame.locator("#speedPresetInput").inputValue(), "faster");
  assert.equal(await frame.locator("#riskInput").isChecked(), false);
  assert.equal(requests.length, reloadCount);
  await frame.locator("#riskInput").check();
  await frame.locator("#previewButton").click();
  await waitForState(frame, "waiting");
  await frame.locator("#stopButton").click();
  await frame.waitForFunction(expected => document.getElementById("statusBadge").dataset.state === "stopped" &&
    !document.getElementById("previewButton").disabled && document.getElementById("tokenInput").value === expected, testToken);
  await assertPrivateState(frame, true);
  await frame.locator("#previewButton").click();
  await waitForState(frame, "waiting");
  await frame.locator("#forgetTokenButton").click();
  await frame.waitForFunction(async () => !("wiperSavedToken" in await chrome.storage.local.get(null)) && !document.getElementById("previewButton").disabled);
  await assertPrivateState(frame);
  await frame.locator("#tokenInput").fill(testToken);
  await frame.locator("#rememberTokenInput").check();
  await frame.waitForFunction(async () => (await chrome.storage.local.get("wiperSavedToken")).wiperSavedToken !== undefined);
  scenario = "unauthorized";
  await frame.locator("#previewButton").click();
  await frame.waitForFunction(async () => document.getElementById("statusBadge").dataset.state === "error" &&
    !("wiperSavedToken" in await chrome.storage.local.get(null)) && !document.getElementById("previewButton").disabled);
  await assertPrivateState(frame);
  assert.equal(await frame.locator("#rememberTokenInput").isChecked(), false);
  console.log("Passed: opt-in token reload, no automatic requests, faster preset persistence, Stop keeps credentials, Forget clears them, and rejected-token cleanup.");

  for (const origin of ["https://ptb.discord.com", "https://canary.discord.com"]) {
    const clientTab = await context.newPage();
    await clientTab.goto(`${origin}/channels/@me/${channelId}`);
    await waitForPanel(clientTab);
    await clientTab.close();
  }
  assert.deepEqual(browserErrors, []);
  assert.deepEqual(unexpectedRequests, []);
  console.log("Passed: hiding pauses, Stop aborts waits, 401 stops without retries, empty history clears credentials, reload/privacy settings, responsive layouts, and PTB/Canary mounting.");
  console.log(`Browser smoke passed with ${requests.length} intercepted API requests and zero real Discord API requests.`);
} finally {
  await context?.close();
  await rm(profileDirectory, { recursive: true, force: true });
}
