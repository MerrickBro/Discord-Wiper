import { DiscordClient } from "./discordClient.js";
import { RunControl } from "./control.js";
import { compileFilters, describeFilters, matchesFilters } from "./filters.js";
import { dateScanRanges } from "./dateScan.js";
import { RunMetrics } from "./runMetrics.js";
import { isSnowflake, safeErrorMessage, validateChannelId, validateDelays, validateToken, WiperError } from "./validation.js";

const deletableTypes = new Set([0, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20,
  22, 23, 25, 26, 27, 28, 29, 31, 32, 36, 37, 38, 39, 44, 46]);

function emptyState() {
  return { phase: "idle", paused: false, channelId: "", authorId: "", channelKind: "",
    scanned: 0, matched: 0, deleted: 0, alreadyGone: 0, kept: 0, skipped: 0, filtered: 0, pages: 0,
    filtersActive: false, filterSummary: "Filters off.", dateOptimized: false,
    rateLimits: 0, waitUntil: 0, waitReason: "", error: "" };
}

/** Two phases: scan accessible history, then explicitly delete the frozen owner-only preview. */
export class MessageWiper {
  #state = emptyState();
  #client = null;
  #control = null;
  #messageIds = [];
  #task = null;
  #onChange;
  #onLog;
  #clientFactory;
  #controlFactory;
  #maxCandidates;
  #filters = null;
  #metrics;

  constructor({ onChange = () => {}, onLog = () => {},
    clientFactory = options => new DiscordClient(options),
    controlFactory = () => new RunControl(), maxCandidates = 100000, clock = Date.now } = {}) {
    this.#onChange = onChange;
    this.#onLog = onLog;
    this.#clientFactory = clientFactory;
    this.#controlFactory = controlFactory;
    this.#maxCandidates = maxCandidates;
    this.#metrics = new RunMetrics(clock);
  }

  get state() {
    return { ...this.#state, ...this.#metrics.snapshot({ phase: this.#state.phase,
      processed: this.#state.deleted + this.#state.alreadyGone + this.#state.kept,
      total: this.#state.matched, waitUntil: this.#state.waitUntil }) };
  }

  preview({ token, channelId, minDelay = 1000, maxDelay = 2000, filters = {} }) {
    if (this.#task || this.#state.phase === "ready") throw new WiperError("Stop the current session before creating another preview.");
    channelId = validateChannelId(channelId);
    validateDelays(minDelay, maxDelay);
    token = validateToken(token);
    const compiledFilters = compileFilters(filters);
    this.#clearSecrets();
    this.#filters = compiledFilters;
    this.#state = { ...emptyState(), phase: "scanning", channelId,
      filtersActive: compiledFilters.dateEnabled || compiledFilters.wordEnabled || compiledFilters.keepPinned || compiledFilters.attachmentEnabled,
      filterSummary: describeFilters(compiledFilters), dateOptimized: compiledFilters.dateEnabled };
    this.#metrics.start();
    this.#control = this.#controlFactory();
    this.#client = this.#clientFactory({ token, minDelay, maxDelay, control: this.#control,
      onWait: ({ until, reason }) => { this.#state.waitUntil = until; this.#state.waitReason = reason; this.#emit(); },
      onLog: (message, level) => this.#onLog(message, level),
      onRateLimit: () => { this.#state.rateLimits++; this.#emit(); } });
    token = "";
    this.#emit();
    this.#task = this.#scan();
    return this.#task;
  }

  deletePreview({ channelId, acceptRisk }) {
    if (this.#task || this.#state.phase !== "ready" || !this.#messageIds.length) {
      throw new WiperError("Create a complete preview before starting deletion.");
    }
    if (acceptRisk !== true || channelId !== this.#state.channelId) {
      throw new WiperError("Confirm the exact channel ID and permanent deletion before starting.");
    }
    this.#state.phase = "deleting";
    this.#metrics.beginPhase("deleting");
    this.#emit();
    this.#task = this.#delete();
    return this.#task;
  }

  pause() {
    if (!["scanning", "deleting"].includes(this.#state.phase) || this.#state.paused) return;
    this.#control.pause();
    this.#state.paused = true;
    this.#metrics.pause();
    this.#onLog("Paused. A request already sent may finish; the next request will wait.", "info");
    this.#emit();
  }

  resume() {
    if (!this.#state.paused) return;
    this.#control.resume();
    this.#state.paused = false;
    this.#metrics.resume();
    this.#onLog("Resumed. Any remaining Discord cooldown still applies.", "info");
    this.#emit();
  }

  async stop() {
    this.#metrics.finish();
    this.#control?.stop();
    this.#client?.dispose();
    if (this.#task) {
      this.#state.phase = "stopping";
      this.#state.paused = false;
      this.#emit();
      await this.#task.catch(() => {});
    } else {
      this.#state.phase = "stopped";
      this.#state.paused = false;
      this.#clearSecrets();
      this.#emit();
      this.#onLog("Stopped. Session token and preview cleared.", "info");
    }
  }

  #emit() { this.#onChange(this.state); }

  #clearSecrets() {
    this.#client?.dispose();
    this.#client = null;
    this.#messageIds.length = 0;
    this.#filters = null;
    this.#state.waitUntil = 0;
    this.#state.waitReason = "";
  }

  #fail(error) {
    this.#metrics.finish();
    const aborted = this.#control?.signal.aborted;
    this.#state.phase = aborted ? "stopped" : "error";
    this.#state.paused = false;
    this.#state.error = aborted ? "" : safeErrorMessage(error);
    this.#clearSecrets();
    this.#onLog(aborted ? "Stopped. Session token and preview cleared." : this.#state.error, aborted ? "info" : "error");
    this.#emit();
  }

  async #scan() {
    try {
      const self = await this.#client.getSelf();
      if (!isSnowflake(self?.id)) throw new WiperError("Unable to verify the account author ID. Stopped.");
      this.#state.authorId = self.id;
      this.#onLog(`Verified account ${self.id}. Previewing only this account's messages.`, "info");
      const channel = await this.#client.getChannel(this.#state.channelId);
      if (channel?.id !== this.#state.channelId) throw new WiperError("Discord returned a different channel. Stopped.");
      this.#state.channelKind = [1, 3].includes(channel.type) ? "Direct message" : "Channel / thread";
      let oldestSeen = "";
      const ranges = dateScanRanges(this.#filters);
      if (this.#filters.dateEnabled) this.#onLog("Date bounds applied. Preview skips history outside the selected date windows.", "info");
      scanHistory: for (const range of ranges) {
        let before = range.before;
        if (before && oldestSeen && BigInt(oldestSeen) < BigInt(before)) before = oldestSeen;
        for (;;) {
          await this.#control.checkpoint();
          const messages = await this.#client.getMessages(this.#state.channelId, before);
          if (!Array.isArray(messages) || messages.length > 100) throw new WiperError("Unexpected message page. Stopped.");
          if (!messages.length) break scanHistory;
          const pageIds = new Set();
          let previousId = "";
          for (const message of messages) {
            if (!isSnowflake(message?.id) || message.channel_id !== this.#state.channelId ||
                !isSnowflake(message.author?.id) || pageIds.has(message.id) ||
                (before && BigInt(message.id) >= BigInt(before)) ||
                (this.#filters.dateEnabled && previousId && BigInt(message.id) >= BigInt(previousId))) {
              throw new WiperError("Message pagination or channel validation failed. Stopped.");
            }
            pageIds.add(message.id);
            previousId = message.id;
          }
          const oldestId = [...pageIds].reduce((oldest, id) => BigInt(id) < BigInt(oldest) ? id : oldest);
          this.#state.pages++;
          this.#state.scanned += messages.length;
          for (const message of messages) {
            if (message.author.id !== self.id || message.webhook_id) continue;
            if (!deletableTypes.has(message.type)) { this.#state.skipped++; continue; }
            if (!matchesFilters(message, this.#filters)) { this.#state.filtered++; continue; }
            if (this.#messageIds.length >= this.#maxCandidates) {
              throw new WiperError(`Preview exceeded ${this.#maxCandidates.toLocaleString()} eligible messages. Stopped without deleting anything.`);
            }
            this.#messageIds.push(message.id);
          }
          this.#state.matched = this.#messageIds.length;
          before = oldestId;
          oldestSeen = oldestId;
          this.#emit();
          this.#onLog(`Page ${this.#state.pages}: ${this.#state.scanned.toLocaleString()} scanned · ${this.#state.matched.toLocaleString()} eligible.`, "info");
          if (range.lowerId && BigInt(oldestId) <= BigInt(range.lowerId)) break;
        }
      }
      await this.#control.checkpoint();
      this.#state.phase = this.#messageIds.length ? "ready" : "complete";
      this.#metrics.endPhase();
      if (!this.#messageIds.length) { this.#metrics.finish(); this.#clearSecrets(); }
      this.#onLog(this.#messageIds.length ?
        `Preview ready: ${this.#state.matched.toLocaleString()} own messages. Start requires confirmation; nothing has been deleted.` :
        "No eligible messages found in the selected accessible history. Missing history permission can also return an empty result. Session token cleared.", "info");
      this.#emit();
      return this.state;
    } catch (error) {
      this.#fail(error);
      throw error;
    } finally {
      this.#task = null;
    }
  }

  async #delete() {
    try {
      const self = await this.#client.getSelf();
      if (self?.id !== this.#state.authorId) throw new WiperError("The authenticated account changed. Stopped without deleting any messages.");
      for (const messageId of this.#messageIds) {
        await this.#control.checkpoint();
        if (this.#filters.keepPinned) {
          const current = await this.#client.getMessage(this.#state.channelId, messageId);
          if (current === null) {
            this.#state.alreadyGone++;
            this.#emit();
            this.#onLog(`Already absent message ${messageId}.`, "info");
            continue;
          }
          if (current?.id !== messageId || current.channel_id !== this.#state.channelId || current.author?.id !== this.#state.authorId ||
              current.webhook_id || !deletableTypes.has(current.type) || typeof current.pinned !== "boolean") {
            throw new WiperError("Message ownership, channel, or pinned-status verification failed. Stopped.");
          }
          if (current.pinned) {
            this.#state.kept++;
            this.#emit();
            this.#onLog(`Kept message ${messageId}: it is now pinned.`, "info");
            continue;
          }
        }
        await this.#control.checkpoint();
        const result = await this.#client.deleteMessage(this.#state.channelId, messageId);
        if (result.alreadyGone) this.#state.alreadyGone++;
        else this.#state.deleted++;
        this.#emit();
        this.#onLog(`${result.alreadyGone ? "Already absent" : "Deleted"} message ${messageId}.`, "info");
      }
      this.#state.phase = "complete";
      this.#state.paused = false;
      this.#metrics.finish();
      this.#clearSecrets();
      this.#onLog(`Complete: ${this.#state.deleted.toLocaleString()} deleted · ${this.#state.alreadyGone.toLocaleString()} already absent · ${this.#state.kept.toLocaleString()} kept after pin checks. Session token cleared.`, "info");
      this.#emit();
      return this.state;
    } catch (error) {
      this.#fail(error);
      throw error;
    } finally {
      this.#task = null;
    }
  }
}
