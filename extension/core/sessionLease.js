import { WiperError } from "./validation.js";

/** Holds an extension-origin Web Lock through preview, confirmation, and deletion. */
export class SessionLease {
  #locks;
  #release = null;
  #lockTask = null;

  constructor(locks = globalThis.navigator?.locks) { this.#locks = locks; }

  async acquire() {
    if (this.#release) return;
    if (!this.#locks) throw new WiperError("This browser does not support the session lock. Use a current Chromium browser.");
    if (this.#lockTask) await this.#lockTask;
    let resolveAcquire;
    let rejectAcquire;
    const acquired = new Promise((resolve, reject) => { resolveAcquire = resolve; rejectAcquire = reject; });
    this.#lockTask = this.#locks.request("merrickDiscordWiperSession", { ifAvailable: true }, async lock => {
      if (!lock) {
        rejectAcquire(new WiperError("Another Discord tab has an active Wiper session. Stop that session first."));
        return;
      }
      await new Promise(resolve => {
        this.#release = resolve;
        resolveAcquire();
      });
    });
    this.#lockTask.catch(rejectAcquire);
    await acquired;
  }

  async release() {
    this.#release?.();
    this.#release = null;
    await this.#lockTask;
    this.#lockTask = null;
  }
}
