import { DiscordClient } from "./discordClient.js";
import { RunControl } from "./control.js";
import { compileFilters, describeFilters, matchesFilters } from "./filters.js";
import { isSnowflake, safeErrorMessage, validateChannelId, validateDelays, validateToken, WiperError } from "./validation.js";

const deletableTypes = new Set([0, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20,
  22, 23, 25, 26, 27, 28, 29, 31, 32, 36, 37, 38, 39, 44, 46]);

function emptyState() {
  return { phase: "idle", paused: false, channelId: "", authorId: "", channelKind: "",
    scanned: 0, matched: 0, deleted: 0, alreadyGone: 0, skipped: 0, filtered: 0, pages: 0,
    filtersActive: false, filterSummary: "Date and word filters off.",
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

  constructor({ onChange = () => {}, onLog = () => {},
    clientFactory = options => new DiscordClient(options),
    controlFactory = () => new RunControl(), maxCandidates = 100000 } = {}) {
    this.#onChange = onChange;
    this.#onLog = onLog;
    this.#clientFactory = clientFactory;
    this.#controlFactory = controlFactory;
    this.#maxCandidates = maxCandidates;
  }

  get state() { return { ...this.#state }; }

  preview({ token, channelId, minDelay = 1000, maxDelay = 2000, filters = {} }) {
    if (this.#task || this.#state.phase === "ready") throw new WiperError("Stop the current session before creating another preview.");
    channelId = validateChannelId(channelId);
    validateDelays(minDelay, maxDelay);
    token = validateToken(token);
    const compiledFilters = compileFilters(filters);
    this.#clearSecrets();
    this.#filters = compiledFilters;
    this.#state = { ...emptyState(), phase: "scanning", channelId,
      filtersActive: compiledFilters.dateEnabled || compiledFilters.wordEnabled, filterSummary: describeFilters(compiledFilters) };
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
    this.#emit();
    this.#task = this.#delete();
    return this.#task;
  }

  pause() {
    if (!["scanning", "deleting"].includes(this.#state.phase) || this.#state.paused) return;
    this.#control.pause();
    this.#state.paused = true;
    this.#onLog("Paused. A request already sent may finish; the next request will wait.", "info");
    this.#emit();
  }

  resume() {
    if (!this.#state.paused) return;
    this.#control.resume();
    this.#state.paused = false;
    this.#onLog("Resumed. Any remaining Discord cooldown still applies.", "info");
    this.#emit();
  }

  async stop() {
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
      let before = "";
      for (;;) {
        await this.#control.checkpoint();
        const messages = await this.#client.getMessages(this.#state.channelId, before);
        if (!Array.isArray(messages) || messages.length > 100) throw new WiperError("Unexpected message page. Stopped.");
        if (!messages.length) break;
        const pageIds = new Set();
        for (const message of messages) {
          if (!isSnowflake(message?.id) || message.channel_id !== this.#state.channelId ||
              !isSnowflake(message.author?.id) || pageIds.has(message.id) ||
              (before && BigInt(message.id) >= BigInt(before))) {
            throw new WiperError("Message pagination or channel validation failed. Stopped.");
          }
          pageIds.add(message.id);
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
        this.#emit();
        this.#onLog(`Page ${this.#state.pages}: ${this.#state.scanned.toLocaleString()} scanned · ${this.#state.matched.toLocaleString()} eligible.`, "info");
      }
      await this.#control.checkpoint();
      this.#state.phase = this.#messageIds.length ? "ready" : "complete";
      if (!this.#messageIds.length) this.#clearSecrets();
      this.#onLog(this.#messageIds.length ?
        `Preview ready: ${this.#state.matched.toLocaleString()} own messages. Start requires confirmation; nothing has been deleted.` :
        "No eligible messages found in accessible history. Missing history permission can return an empty result. Session token cleared.", "info");
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
        const result = await this.#client.deleteMessage(this.#state.channelId, messageId);
        if (result.alreadyGone) this.#state.alreadyGone++;
        else this.#state.deleted++;
        this.#emit();
        this.#onLog(`${result.alreadyGone ? "Already absent" : "Deleted"} message ${messageId}.`, "info");
      }
      this.#state.phase = "complete";
      this.#clearSecrets();
      this.#onLog(`Complete: ${this.#state.deleted.toLocaleString()} deleted · ${this.#state.alreadyGone.toLocaleString()} already absent. Session token cleared.`, "info");
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
