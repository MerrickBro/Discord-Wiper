import assert from "node:assert/strict";
import test from "node:test";
import { TokenStore, savedTokenKey } from "../extension/core/tokenStore.js";
import { testToken, deferred, nextTurn } from "./helpers.js";

function createStorage(initial = {}) {
  const values = { ...initial };
  const calls = [];
  return { values, calls,
    async setAccessLevel(options) { calls.push(["access", options.accessLevel]); },
    async get(key) { calls.push(["get", key]); return { [key]: values[key] }; },
    async set(items) { calls.push(["set", Object.keys(items)]); Object.assign(values, items); },
    async remove(key) { calls.push(["remove", key]); delete values[key]; }
  };
}

test("default load never saves a token and exposes no public credential fields", async () => {
  const storage = createStorage();
  const store = new TokenStore(storage, null);
  assert.equal(await store.load(), "");
  assert.deepEqual(storage.values, {});
  assert.deepEqual(Object.keys(store), []);
  assert.deepEqual(storage.calls, [["access", "TRUSTED_CONTEXTS"], ["get", savedTokenKey]]);
});

test("explicit save persists only the validated token; a fresh store restores it", async () => {
  const storage = createStorage({ wiperPreferences: { theme: "light" } });
  await new TokenStore(storage, null).save(`  ${testToken}  `);
  assert.deepEqual(storage.values, { wiperPreferences: { theme: "light" }, [savedTokenKey]: testToken });
  assert.equal(await new TokenStore(storage, null).load(), testToken);
  assert.ok(!JSON.stringify(storage.calls).includes(testToken));
});

test("invalid input never reaches persistent storage", () => {
  const storage = createStorage();
  const store = new TokenStore(storage, null);
  for (const token of ["", "short", `Bearer ${testToken}`, 123]) assert.throws(() => store.save(token));
  assert.deepEqual(storage.calls, []);
  assert.deepEqual(storage.values, {});
});

test("a malformed saved token is removed instead of restored", async () => {
  const storage = createStorage({ [savedTokenKey]: { token: testToken } });
  assert.equal(await new TokenStore(storage, null).load(), "");
  assert.equal(savedTokenKey in storage.values, false);
});

test("failure to restrict storage access prevents credential reads and writes", async () => {
  const storage = createStorage({ [savedTokenKey]: testToken });
  storage.setAccessLevel = async () => { throw new Error("Access restriction failed"); };
  const store = new TokenStore(storage, null);
  await assert.rejects(store.save(testToken), /restriction/);
  await assert.rejects(store.load(), /restriction/);
  assert.deepEqual(storage.calls, []);
});

test("Forget removes credentials without deleting unrelated preferences", async () => {
  const storage = createStorage({ [savedTokenKey]: testToken, wiperPreferences: { minDelay: 500 } });
  const store = new TokenStore(storage, null);
  assert.equal(await store.forget(), true);
  assert.deepEqual(storage.values, { wiperPreferences: { minDelay: 500 } });
  assert.equal(await store.load(), "");
});

test("Forget waits for an earlier save so a late write cannot recreate the token", async () => {
  const storage = createStorage();
  const gate = deferred();
  storage.set = async items => { await gate.promise; Object.assign(storage.values, items); };
  const store = new TokenStore(storage, null);
  const saving = store.save(testToken);
  const forgetting = store.forget();
  await nextTurn();
  assert.equal(storage.calls.some(([operation]) => operation === "remove"), false);
  gate.resolve();
  await Promise.all([saving, forgetting]);
  assert.deepEqual(storage.values, {});
});

test("rejected-token cleanup preserves a newer replacement token", async () => {
  const replacement = "fictional-newer-replacement-token-no-account";
  const storage = createStorage({ [savedTokenKey]: replacement });
  const store = new TokenStore(storage, null);
  assert.equal(await store.forget(testToken), false);
  assert.equal(await store.load(), replacement);
  assert.equal(await store.forget(replacement), true);
  assert.equal(await store.load(), "");
});
