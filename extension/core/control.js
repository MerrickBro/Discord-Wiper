export function abortError() {
  return new DOMException("The operation was stopped.", "AbortError");
}

export function abortableSleep(duration, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, duration);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Pauses before the next request; stopping also aborts active fetches and waits. */
export class RunControl {
  #controller = new AbortController();
  #waiters = new Set();
  #sleepImpl;
  #paused = false;

  constructor({ sleepImpl = abortableSleep } = {}) {
    this.#sleepImpl = sleepImpl;
  }

  get signal() { return this.#controller.signal; }
  get paused() { return this.#paused; }

  pause() { this.#paused = true; }

  resume() {
    this.#paused = false;
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
  }

  stop() {
    this.#controller.abort();
    this.resume();
  }

  async checkpoint() {
    if (this.signal.aborted) throw abortError();
    while (this.#paused) {
      await new Promise(resolve => this.#waiters.add(resolve));
      if (this.signal.aborted) throw abortError();
    }
  }

  async sleep(duration) {
    await this.checkpoint();
    await this.#sleepImpl(duration, this.signal);
    await this.checkpoint();
  }
}
