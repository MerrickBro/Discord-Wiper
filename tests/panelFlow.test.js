import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { channelId, authorId, testToken, message, jsonResponse, nextTurn } from "./helpers.js";

class Element {
  constructor(id = "", source = "") {
    this.id = id;
    this.value = /value="([^"]*)"/.exec(source)?.[1] ?? "";
    this.type = /type="([^"]*)"/.exec(source)?.[1] ?? "";
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.dataset = {};
    this.children = [];
    this.handlers = new Map();
    this.attributes = new Map();
    this.scrollHeight = 100;
    this.clientHeight = 104;
    this.scrollTop = 0;
    this.open = false;
    this.text = "";
  }
  addEventListener(type, callback) { this.handlers.set(type, [...(this.handlers.get(type) ?? []), callback]); }
  async emit(type) { for (const callback of this.handlers.get(type) ?? []) await callback({ preventDefault() {} }); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren() { this.children = []; }
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
  get firstElementChild() { return this.children[0]; }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(""); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
}

async function createPanel(context, initial = {}, scenario = "normal") {
  const html = await readFile(new URL("../extension/panel.html", import.meta.url), "utf8");
  const elements = Object.fromEntries([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)]
    .map(match => [match[1], new Element(match[1], match[0])]));
  const values = structuredClone(initial);
  const changes = [];
  const requests = [];
  let rejectStorage = false;
  const storage = {
    async setAccessLevel() { if (rejectStorage) throw new Error("Fictional storage access failure"); },
    async get(key) { return key ? { [key]: values[key] } : { ...values }; },
    async set(items) {
      const updated = Object.fromEntries(Object.entries(items).map(([key, value]) => [key, { oldValue: values[key], newValue: value }]));
      Object.assign(values, items);
      for (const listener of changes) listener(updated, "local");
    },
    async remove(key) {
      const oldValue = values[key];
      delete values[key];
      if (oldValue !== undefined) for (const listener of changes) listener({ [key]: { oldValue } }, "local");
    }
  };
  const heldLocks = new Map();
  const locks = { async request(name, options, callback) {
    if (typeof options === "function") { callback = options; options = {}; }
    if (heldLocks.has(name) && options.ifAvailable) return callback(null);
    if (heldLocks.has(name)) await heldLocks.get(name);
    let release;
    heldLocks.set(name, new Promise(resolve => { release = resolve; }));
    try { return await callback({ name }); }
    finally { heldLocks.delete(name); release(); }
  } };
  const window = new Element();
  window.parent = window;
  const document = new Element();
  document.documentElement = new Element();
  document.querySelectorAll = () => Object.values(elements);
  document.createElement = () => new Element();
  const originals = new Map();
  const globals = {
    window, document, location: { href: "chrome-extension://fictional/panel.html" },
    navigator: { locks },
    chrome: { storage: { local: storage, onChanged: { addListener(callback) { changes.push(callback); } } } },
    fetch: async (url, options) => {
      assert.equal(options.headers.Authorization, testToken);
      const path = new URL(url).pathname;
      requests.push({ path, method: options.method });
      if (scenario === "unauthorized") return jsonResponse({ message: testToken }, 401);
      if (path === "/api/v10/users/@me") return jsonResponse({ id: authorId });
      if (path === `/api/v10/channels/${channelId}`) return jsonResponse({ id: channelId, type: 1 });
      if (options.method === "DELETE") return jsonResponse(null, 204);
      return jsonResponse(new URL(url).searchParams.has("before") ? [] : [message(1)]);
    }
  };
  for (const [key, value] of Object.entries(globals)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1791182000000 });
  context.after(async () => {
    await window.emit("pagehide");
    await nextTurn();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  await import(`../extension/panel.js?panelTest=${Math.random()}`);
  elements.channelInput.value = channelId;
  const until = async predicate => {
    for (let attempt = 0; attempt < 30; attempt++) {
      await nextTurn();
      if (predicate()) return;
      context.mock.timers.tick(1000);
    }
    throw new Error(`Panel did not reach the expected state: ${elements.statusText.textContent}`);
  };
  return { elements, values, requests, until, rejectStorage: () => { rejectStorage = true; } };
}

test("panel restores opted-in credentials and faster preferences without making requests", async context => {
  const panel = await createPanel(context, { wiperSavedToken: testToken,
    wiperPreferences: { minDelay: 500, maxDelay: 750, theme: "light" } });
  assert.equal(panel.elements.tokenInput.value, testToken);
  assert.equal(panel.elements.tokenInput.type, "password");
  assert.equal(panel.elements.rememberTokenInput.checked, true);
  assert.equal(panel.elements.speedPresetInput.value, "faster");
  assert.equal(panel.elements.riskInput.checked, false);
  assert.equal(panel.elements.startButton.disabled, true);
  assert.equal(panel.elements.tokenModeLabel.textContent, "Saved locally");
  assert.deepEqual(panel.requests, []);
});

test("panel saves on explicit opt-in, then preserves the token through preview and confirmed deletion", async context => {
  const panel = await createPanel(context);
  const elements = panel.elements;
  elements.tokenInput.value = testToken;
  elements.rememberTokenInput.checked = true;
  await elements.rememberTokenInput.emit("change");
  assert.equal(panel.values.wiperSavedToken, testToken);
  assert.deepEqual(panel.requests, []);
  elements.riskInput.checked = true;
  const preview = elements.configForm.emit("submit");
  await panel.until(() => elements.statusBadge.dataset.state === "ready" && !elements.startButton.disabled);
  await preview;
  assert.equal(elements.tokenInput.value, "");
  assert.equal(panel.requests.some(request => request.method === "DELETE"), false);
  await elements.startButton.emit("click");
  elements.confirmationInput.value = channelId;
  elements.permanentInput.checked = true;
  const deleting = elements.confirmForm.emit("submit");
  await panel.until(() => elements.statusBadge.dataset.state === "complete" && !elements.previewButton.disabled);
  await deleting;
  assert.equal(elements.deletedCount.textContent, "1");
  assert.equal(elements.tokenInput.value, testToken);
  assert.equal(elements.tokenInput.type, "password");
  assert.equal(panel.values.wiperSavedToken, testToken);
  assert.match(elements.statusDetail.textContent, /Saved token kept/);
  assert.ok(!elements.logList.textContent.includes(testToken));
});

test("Stop keeps the saved token, while Forget during a paused scan removes it and halts requests", async context => {
  const panel = await createPanel(context, { wiperSavedToken: testToken });
  const elements = panel.elements;
  elements.riskInput.checked = true;
  const preview = elements.configForm.emit("submit");
  await panel.until(() => elements.statusBadge.dataset.state === "waiting");
  await elements.stopButton.emit("click");
  await preview;
  assert.equal(elements.tokenInput.value, testToken);
  assert.equal(panel.values.wiperSavedToken, testToken);
  const nextPreview = elements.configForm.emit("submit");
  await panel.until(() => elements.statusBadge.dataset.state === "waiting");
  await elements.pauseButton.emit("click");
  await elements.forgetTokenButton.emit("click");
  await nextPreview;
  assert.equal("wiperSavedToken" in panel.values, false);
  assert.equal(elements.tokenInput.value, "");
  assert.equal(elements.rememberTokenInput.checked, false);
  assert.equal(elements.statusBadge.dataset.state, "stopped");
  const count = panel.requests.length;
  context.mock.timers.tick(60000);
  await nextTurn();
  assert.equal(panel.requests.length, count);
});

test("a rejected saved token is removed, never restored, and cannot trigger a retry", async context => {
  const panel = await createPanel(context, { wiperSavedToken: testToken }, "unauthorized");
  panel.elements.riskInput.checked = true;
  const preview = panel.elements.configForm.emit("submit");
  await panel.until(() => panel.elements.statusBadge.dataset.state === "error" && !panel.elements.previewButton.disabled);
  await preview;
  assert.equal("wiperSavedToken" in panel.values, false);
  assert.equal(panel.elements.tokenInput.value, "");
  assert.equal(panel.elements.rememberTokenInput.checked, false);
  assert.equal(panel.requests.length, 1);
  assert.ok(!panel.elements.logList.textContent.includes(testToken));
});

test("opting out clears the stored copy and keeps the current input in memory", async context => {
  const panel = await createPanel(context, { wiperSavedToken: testToken });
  panel.elements.rememberTokenInput.checked = false;
  await panel.elements.rememberTokenInput.emit("change");
  assert.equal("wiperSavedToken" in panel.values, false);
  assert.equal(panel.elements.tokenInput.value, testToken);
  assert.equal(panel.elements.tokenModeLabel.textContent, "Memory only");
  assert.deepEqual(panel.requests, []);
});

test("failed credential storage leaves the token in memory and makes no API requests", async context => {
  const panel = await createPanel(context);
  panel.elements.tokenInput.value = testToken;
  panel.rejectStorage();
  panel.elements.rememberTokenInput.checked = true;
  await panel.elements.rememberTokenInput.emit("change");
  assert.equal("wiperSavedToken" in panel.values, false);
  assert.equal(panel.elements.rememberTokenInput.checked, false);
  assert.equal(panel.elements.tokenInput.value, testToken);
  assert.equal(panel.elements.formError.hidden, false);
  assert.deepEqual(panel.requests, []);
});
