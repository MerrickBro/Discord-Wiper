import { validateToken } from "./validation.js";

export const savedTokenKey = "wiperSavedToken";

export function cleanSavedToken(value) {
  try { return validateToken(value); } catch { return ""; }
}

export class TokenStore {
  #storage;
  #locks;
  #pending = Promise.resolve();

  constructor(storage, locks = globalThis.navigator?.locks) {
    this.#storage = storage;
    this.#locks = locks;
  }

  #run(operation) {
    const task = this.#pending.then(async () => {
      await this.#storage.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
      return this.#locks ? this.#locks.request("merrickWiperSavedToken", operation) : operation();
    });
    this.#pending = task.catch(() => {});
    return task;
  }

  load() {
    return this.#run(async () => {
      const values = await this.#storage.get(savedTokenKey);
      const token = cleanSavedToken(values[savedTokenKey]);
      if (!token && values[savedTokenKey] !== undefined) await this.#storage.remove(savedTokenKey);
      return token;
    });
  }

  save(token) {
    token = validateToken(token);
    return this.#run(async () => {
      await this.#storage.set({ [savedTokenKey]: token });
    });
  }

  forget(expectedToken) {
    return this.#run(async () => {
      if (expectedToken !== undefined) {
        const values = await this.#storage.get(savedTokenKey);
        if (values[savedTokenKey] !== expectedToken) return false;
      }
      await this.#storage.remove(savedTokenKey);
      return true;
    });
  }
}
