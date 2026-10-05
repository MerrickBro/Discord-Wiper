export class RunMetrics {
  #clock;
  #started = null;
  #ended = null;
  #phase = "";
  #phaseStarted = null;
  #phaseEnded = null;
  #pausedAt = null;
  #pausedMs = 0;

  constructor(clock = Date.now) { this.#clock = clock; }

  start() {
    this.#started = this.#clock();
    this.#ended = null;
    this.beginPhase("scanning");
  }

  beginPhase(phase) {
    this.#phase = phase;
    this.#phaseStarted = this.#clock();
    this.#phaseEnded = null;
    this.#pausedAt = null;
    this.#pausedMs = 0;
  }

  pause() { if (this.#pausedAt === null) this.#pausedAt = this.#clock(); }

  resume() {
    if (this.#pausedAt === null) return;
    this.#pausedMs += Math.max(0, this.#clock() - this.#pausedAt);
    this.#pausedAt = null;
  }

  endPhase() {
    this.resume();
    if (this.#phaseStarted !== null && this.#phaseEnded === null) this.#phaseEnded = this.#clock();
  }

  finish() {
    this.endPhase();
    if (this.#started !== null && this.#ended === null) this.#ended = this.#clock();
  }

  snapshot({ phase, processed, total, waitUntil = 0 }) {
    const now = this.#clock();
    const elapsedMs = this.#started === null ? 0 : Math.max(0, (this.#ended ?? now) - this.#started);
    const currentPause = this.#pausedAt === null ? 0 : Math.max(0, now - this.#pausedAt);
    const activeMs = this.#phaseStarted === null ? 0 : Math.max(0, (this.#phaseEnded ?? now) - this.#phaseStarted - this.#pausedMs - currentPause);
    const messagesPerMinute = this.#phase === "deleting" && processed > 0 && activeMs > 0 ? processed * 60000 / activeMs : null;
    let remainingMs = null;
    if (phase === "deleting" && processed >= 3 && activeMs > 0) {
      const remaining = Math.max(0, total - processed);
      const meanMs = activeMs / processed;
      const knownWait = Math.max(0, waitUntil - now);
      remainingMs = remaining ? Math.ceil(Math.max(meanMs * remaining, knownWait + meanMs * (remaining - 1))) : 0;
    } else if (phase === "complete" && this.#phase === "deleting") remainingMs = 0;
    return { elapsedMs, activeMs, messagesPerMinute, remainingMs };
  }
}
