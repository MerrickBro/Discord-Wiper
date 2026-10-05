import { MessageWiper } from "./core/wiper.js";
import { SessionLease } from "./core/sessionLease.js";
import { loadPreferences, savePreferences } from "./core/preferences.js";
import { TokenStore, savedTokenKey, cleanSavedToken } from "./core/tokenStore.js";
import { pacePresets, paceFromDelays } from "./core/pacing.js";
import { compileFilters } from "./core/filters.js";
import { discordOrigins, isSnowflake, safeErrorMessage, validateChannelId, validateDelays, validateToken, WiperError } from "./core/validation.js";

const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map(element => [element.id, element]));
const parentOrigin = new URL(location.href).searchParams.get("parentOrigin");
const bridgeId = new URL(location.href).searchParams.get("bridgeId");
const embedded = window.parent !== window && discordOrigins.includes(parentOrigin) && Boolean(bridgeId);
const lease = new SessionLease();
const tokenStore = new TokenStore(chrome.storage.local);
let acquiring = false;
let stopping = false;
let channelRequested = false;
let waitTimer = null;
let savedTheme = "dark";
let preferencesReady = false;
let credentialBusy = false;
let rememberedToken = "";
let savedTokenPresent = false;
let sessionSavedToken = "";
let previewWordQuery = "";

function filterValues() {
  return { dateEnabled: elements.dateFilterInput.checked, dateMode: elements.dateModeInput.value,
    dateFrom: elements.dateFromInput.value, dateTo: elements.dateToInput.value,
    wordEnabled: elements.wordFilterInput.checked, wordMode: elements.wordModeInput.value, wordQuery: elements.wordQueryInput.value };
}

function renderFilters(locked) {
  const dateEnabled = elements.dateFilterInput.checked;
  const wordEnabled = elements.wordFilterInput.checked;
  const range = ["during", "except"].includes(elements.dateModeInput.value);
  elements.dateFilterFields.hidden = !dateEnabled;
  elements.wordFilterFields.hidden = !wordEnabled;
  elements.dateEndField.hidden = !range;
  elements.dateFromLabel.textContent = range ? "From (inclusive)" : "Date";
  elements.dateFilterInput.disabled = elements.wordFilterInput.disabled = locked || !preferencesReady;
  for (const name of ["dateModeInput", "dateFromInput", "dateToInput"]) {
    elements[name].disabled = locked || !preferencesReady || !dateEnabled || (name === "dateToInput" && !range);
  }
  for (const name of ["wordModeInput", "wordQueryInput"]) elements[name].disabled = locked || !preferencesReady || !wordEnabled;
  elements.dateFromInput.required = dateEnabled;
  elements.dateToInput.required = dateEnabled && range;
  elements.wordQueryInput.required = wordEnabled;
  const activeCount = Number(dateEnabled) + Number(wordEnabled);
  elements.filterModeLabel.textContent = activeCount ? `${activeCount} active` : "Off";
}

function appendLog(message, level = "info") {
  const followingBottom = elements.logList.scrollHeight - elements.logList.clientHeight - elements.logList.scrollTop < 24;
  const entry = document.createElement("li");
  entry.dataset.level = level;
  const timestamp = document.createElement("time");
  const now = new Date();
  timestamp.dateTime = now.toISOString();
  timestamp.textContent = now.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const text = document.createElement("span");
  text.textContent = message;
  entry.append(timestamp, text);
  elements.logList.append(entry);
  while (elements.logList.children.length > 200) elements.logList.firstElementChild.remove();
  if (followingBottom) elements.logList.scrollTop = elements.logList.scrollHeight;
}

function showError(error) {
  const message = safeErrorMessage(error);
  elements.formError.textContent = message;
  elements.formError.hidden = false;
  appendLog(message, "error");
}

function clearError() {
  elements.formError.hidden = true;
  elements.formError.textContent = "";
}

function updateStatus(state) {
  const titles = { idle: "Ready", scanning: "Scanning", ready: "Preview ready", deleting: "Deleting", complete: "Complete", stopped: "Stopped", stopping: "Stopping", error: "Stopped on error" };
  const waiting = state.waitUntil > Date.now() && ["scanning", "deleting"].includes(state.phase);
  const badgeState = state.paused ? "paused" : waiting ? "waiting" : state.phase;
  elements.statusBadge.dataset.state = badgeState;
  elements.statusText.textContent = state.paused ? "Paused" : waiting ? state.waitReason : titles[state.phase];
  let detail = "Preview first. Nothing deletes automatically.";
  if (state.phase === "scanning") detail = "Reading accessible history. No messages are being deleted.";
  if (state.phase === "ready") detail = `${state.matched.toLocaleString()} own messages ready. Start opens the deletion confirmation.`;
  if (state.phase === "deleting") detail = `${(state.deleted + state.alreadyGone).toLocaleString()} / ${state.matched.toLocaleString()} processed · ${state.alreadyGone.toLocaleString()} already absent.`;
  if (state.phase === "complete") detail = `Finished · ${state.deleted.toLocaleString()} deleted · ${state.alreadyGone.toLocaleString()} already absent · ${state.skipped.toLocaleString()} unsupported own messages skipped. ${savedTokenPresent ? "Saved token kept." : "Token cleared."}`;
  if (state.phase === "stopped") detail = `Session and preview cleared. ${savedTokenPresent ? "Saved token kept." : "Token cleared."} A request already sent may have finished.`;
  if (state.phase === "stopping") detail = "Stopping requests and clearing the token. An already-sent deletion may finish.";
  if (state.phase === "error") detail = state.error;
  if (state.paused) detail = "Waiting for Resume. A request already sent may finish. Discord cooldowns remain in effect.";
  else if (waiting) detail = `${state.waitReason}: ${Math.max(0, (state.waitUntil - Date.now()) / 1000).toFixed(1)} s remaining. ${state.phase === "scanning" ? "Preview only." : "Deletion will continue after the wait."}`;
  elements.statusDetail.textContent = detail;
}

function renderState(state) {
  updateStatus(state);
  const locked = acquiring || stopping || credentialBusy || ["scanning", "ready", "deleting", "stopping"].includes(state.phase);
  const active = ["scanning", "deleting"].includes(state.phase);
  renderFilters(locked);
  for (const name of ["tokenInput", "channelInput", "minDelayInput", "maxDelayInput", "rememberChannelInput", "rememberTokenInput", "speedPresetInput", "riskInput", "showTokenButton", "currentChannelButton"]) {
    elements[name].disabled = locked || !preferencesReady;
  }
  elements.tokenInput.placeholder = locked ? "Token held in session memory" : rememberedToken ? "Saved token available" : "Paste your own account token";
  elements.tokenModeLabel.textContent = savedTokenPresent ? "Saved locally" : "Memory only";
  elements.savedTokenHint.hidden = false;
  elements.forgetTokenButton.disabled = acquiring || stopping || credentialBusy || !preferencesReady || (!savedTokenPresent && !elements.tokenInput.value);
  elements.previewButton.disabled = locked || !preferencesReady;
  elements.startButton.disabled = state.phase !== "ready" || stopping || credentialBusy;
  elements.pauseButton.disabled = !active || stopping;
  elements.pauseButton.textContent = state.paused ? "Resume" : "Pause";
  elements.stopButton.disabled = acquiring || stopping || credentialBusy || (!locked && !elements.tokenInput.value);
  elements.scannedCount.textContent = state.scanned.toLocaleString();
  elements.matchedCount.textContent = state.matched.toLocaleString();
  elements.deletedCount.textContent = state.deleted.toLocaleString();
  elements.progressBar.hidden = !["scanning", "ready", "deleting"].includes(state.phase);
  if (state.phase === "scanning") elements.progressBar.removeAttribute("value");
  else {
    elements.progressBar.max = Math.max(1, state.matched);
    elements.progressBar.value = state.deleted + state.alreadyGone;
  }
  elements.accountDetail.hidden = !state.authorId;
  elements.accountDetail.textContent = `Account ${state.authorId} · ${state.channelKind || "Verifying channel"}`;
  elements.filterDetail.hidden = !state.filtersActive;
  elements.filterDetail.textContent = state.filterSummary;
  elements.filteredDetail.hidden = !state.filtered;
  elements.filteredDetail.textContent = `${state.filtered.toLocaleString()} own messages excluded by filters.`;
  if (!active || !state.waitUntil) {
    clearInterval(waitTimer);
    waitTimer = null;
  } else if (!waitTimer) {
    waitTimer = setInterval(() => updateStatus(wiper.state), 250);
  }
}

const wiper = new MessageWiper({ onChange: renderState, onLog: appendLog });

function sendToParent(type) {
  if (embedded) window.parent.postMessage({ type, bridgeId }, parentOrigin);
}

function requestCurrentChannel() {
  if (!embedded) return showError(new WiperError("Open the panel inside a Discord channel, or enter its ID manually."));
  channelRequested = true;
  sendToParent("merrickWiperChannelRequest");
}

function clearTokenField() {
  elements.tokenInput.value = "";
  elements.tokenInput.type = "password";
  elements.showTokenButton.textContent = "Show";
  elements.showTokenButton.setAttribute("aria-pressed", "false");
}

function restoreRememberedToken() {
  if (rememberedToken && elements.rememberTokenInput.checked && !elements.tokenInput.value) {
    elements.tokenInput.value = rememberedToken;
    elements.tokenInput.type = "password";
  }
}

async function removeRejectedToken(error) {
  if (!(error instanceof WiperError) || error.code !== "invalidToken" || !sessionSavedToken) return;
  const rejectedToken = sessionSavedToken;
  if (rememberedToken === rejectedToken) {
    rememberedToken = "";
    elements.rememberTokenInput.checked = false;
  }
  try {
    if (await tokenStore.forget(rejectedToken)) {
      savedTokenPresent = false;
      appendLog("Rejected saved token removed. Paste a current token before trying again.", "warning");
    }
  } catch {
    appendLog("The rejected saved token could not be removed. Use Forget to remove its stored copy.", "error");
  }
}

async function persistPreferences() {
  if (!preferencesReady) return;
  try {
    await savePreferences(chrome.storage.local, {
      minDelay: Number(elements.minDelayInput.value), maxDelay: Number(elements.maxDelayInput.value),
      channelId: elements.channelInput.value.trim(), rememberChannel: elements.rememberChannelInput.checked, theme: savedTheme
    });
  } catch {
    appendLog("Preferences could not be saved. This session can still run.", "warning");
  }
}

function applyTheme(theme) {
  savedTheme = theme;
  document.documentElement.dataset.theme = theme;
  elements.themeButton.setAttribute("aria-label", `Switch to ${theme === "dark" ? "light" : "dark"} theme`);
}

elements.configForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (acquiring || credentialBusy || stopping || !preferencesReady || ["scanning", "ready", "deleting", "stopping"].includes(wiper.state.phase)) return;
  clearError();
  let options;
  try {
    if (!elements.riskInput.checked) throw new WiperError("Acknowledge the account and permanent deletion risks before making API requests.");
    options = { token: validateToken(elements.tokenInput.value || (elements.rememberTokenInput.checked ? rememberedToken : "")), channelId: validateChannelId(elements.channelInput.value),
      ...validateDelays(Number(elements.minDelayInput.value), Number(elements.maxDelayInput.value)), filters: filterValues() };
    compileFilters(options.filters);
    acquiring = true;
    renderState(wiper.state);
    await lease.acquire();
    await persistPreferences();
    sessionSavedToken = "";
    if (elements.rememberTokenInput.checked) {
      try { await tokenStore.save(options.token); }
      catch { throw new WiperError("The token could not be saved. Turn off Remember token to keep it in memory only."); }
      rememberedToken = options.token;
      savedTokenPresent = true;
      sessionSavedToken = options.token;
    }
    clearTokenField();
    acquiring = false;
    const task = wiper.preview(options);
    previewWordQuery = options.filters.wordEnabled ? options.filters.wordQuery.trim() : "";
    options.token = "";
    await task;
  } catch (error) {
    acquiring = true;
    renderState(wiper.state);
    clearTokenField();
    await removeRejectedToken(error);
    if (!wiper.state.error && wiper.state.phase !== "stopped") showError(error);
  } finally {
    if (options) options.token = "";
    if (wiper.state.phase !== "ready") {
      acquiring = true;
      renderState(wiper.state);
      sessionSavedToken = "";
      previewWordQuery = "";
      await lease.release();
      restoreRememberedToken();
    }
    acquiring = false;
    renderState(wiper.state);
  }
});

elements.startButton.addEventListener("click", () => {
  if (wiper.state.phase !== "ready") return;
  elements.confirmDescription.textContent = `This permanently deletes ${wiper.state.matched.toLocaleString()} messages from your verified account in this channel. Messages sent after the preview are excluded. Filter matches are frozen at preview time; later edits do not change this list.`;
  elements.confirmFilters.textContent = `${wiper.state.filterSummary}${previewWordQuery ? ` · Word / phrase: “${previewWordQuery}”` : ""}`;
  elements.confirmChannel.textContent = wiper.state.channelId;
  elements.confirmAccount.textContent = wiper.state.authorId;
  elements.confirmationInput.value = "";
  elements.permanentInput.checked = false;
  elements.confirmDeleteButton.disabled = true;
  elements.confirmDialog.showModal();
  elements.confirmationInput.focus();
});

function updateConfirmation() {
  elements.confirmDeleteButton.disabled = elements.confirmationInput.value === "" ||
    elements.confirmationInput.value !== wiper.state.channelId || !elements.permanentInput.checked || wiper.state.phase !== "ready";
}
elements.confirmationInput.addEventListener("input", updateConfirmation);
elements.permanentInput.addEventListener("change", updateConfirmation);
elements.cancelConfirmButton.addEventListener("click", () => elements.confirmDialog.close());
elements.confirmForm.addEventListener("submit", async event => {
  event.preventDefault();
  updateConfirmation();
  if (elements.confirmDeleteButton.disabled) return;
  const channelId = elements.confirmationInput.value;
  elements.confirmDialog.close();
  clearError();
  try {
    await wiper.deletePreview({ channelId, acceptRisk: elements.permanentInput.checked });
  } catch (error) {
    acquiring = true;
    renderState(wiper.state);
    await removeRejectedToken(error);
    if (!wiper.state.error && wiper.state.phase !== "stopped") showError(error);
  } finally {
    acquiring = true;
    renderState(wiper.state);
    elements.confirmationInput.value = "";
    elements.permanentInput.checked = false;
    sessionSavedToken = "";
    previewWordQuery = "";
    await lease.release();
    restoreRememberedToken();
    acquiring = false;
    renderState(wiper.state);
  }
});

elements.pauseButton.addEventListener("click", () => { wiper.state.paused ? wiper.resume() : wiper.pause(); });
elements.stopButton.addEventListener("click", async () => {
  if (stopping || acquiring || credentialBusy) return;
  stopping = true;
  clearTokenField();
  elements.confirmDialog.close();
  clearError();
  renderState(wiper.state);
  await wiper.stop();
  sessionSavedToken = "";
  previewWordQuery = "";
  await lease.release();
  stopping = false;
  restoreRememberedToken();
  renderState(wiper.state);
});

elements.rememberTokenInput.addEventListener("change", async () => {
  if (!preferencesReady || credentialBusy || acquiring || stopping) return;
  credentialBusy = true;
  renderState(wiper.state);
  clearError();
  try {
    if (elements.rememberTokenInput.checked) {
      const token = validateToken(elements.tokenInput.value || rememberedToken);
      await tokenStore.save(token);
      rememberedToken = token;
      savedTokenPresent = true;
      appendLog("Token saved on this device. Use Forget to remove it.");
    } else {
      await tokenStore.forget();
      rememberedToken = "";
      savedTokenPresent = false;
      appendLog("Saved token removed. The current input stays in memory only.");
    }
  } catch (error) {
    elements.rememberTokenInput.checked = Boolean(rememberedToken);
    showError(error instanceof WiperError ? error : new WiperError("The saved token could not be updated. Try again or use memory-only mode."));
  } finally {
    credentialBusy = false;
    renderState(wiper.state);
  }
});

elements.forgetTokenButton.addEventListener("click", async () => {
  if (acquiring || stopping || credentialBusy || !preferencesReady) return;
  stopping = true;
  rememberedToken = "";
  sessionSavedToken = "";
  previewWordQuery = "";
  elements.rememberTokenInput.checked = false;
  clearTokenField();
  elements.confirmDialog.close();
  clearError();
  renderState(wiper.state);
  await wiper.stop();
  await lease.release();
  try {
    await tokenStore.forget();
    savedTokenPresent = false;
    appendLog("Token forgotten. Saved copy, current input, and this panel's session cleared.");
  } catch {
    showError(new WiperError("The session stopped, but the saved copy could not be removed. Try Forget again."));
  } finally {
    stopping = false;
    renderState(wiper.state);
  }
});

elements.speedPresetInput.addEventListener("change", () => {
  const preset = pacePresets[elements.speedPresetInput.value];
  if (!preset) return;
  elements.minDelayInput.value = preset.minDelay;
  elements.maxDelayInput.value = preset.maxDelay;
  persistPreferences();
});
elements.tokenInput.addEventListener("input", () => renderState(wiper.state));
for (const name of ["dateFilterInput", "dateModeInput", "wordFilterInput", "wordModeInput"]) {
  elements[name].addEventListener("change", () => renderState(wiper.state));
}
elements.showTokenButton.addEventListener("click", () => {
  const showing = elements.tokenInput.type === "password";
  elements.tokenInput.type = showing ? "text" : "password";
  elements.showTokenButton.textContent = showing ? "Hide" : "Show";
  elements.showTokenButton.setAttribute("aria-pressed", String(showing));
});
elements.currentChannelButton.addEventListener("click", requestCurrentChannel);
elements.clearLogsButton.addEventListener("click", () => elements.logList.replaceChildren());
elements.themeButton.addEventListener("click", () => {
  applyTheme(savedTheme === "dark" ? "light" : "dark");
  persistPreferences();
});
elements.closeButton.addEventListener("click", () => { wiper.pause(); sendToParent("merrickWiperClose"); });
for (const name of ["minDelayInput", "maxDelayInput", "channelInput", "rememberChannelInput"]) elements[name].addEventListener("change", () => {
  elements.speedPresetInput.value = paceFromDelays(Number(elements.minDelayInput.value), Number(elements.maxDelayInput.value));
  persistPreferences();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[savedTokenKey]) return;
  rememberedToken = cleanSavedToken(changes[savedTokenKey].newValue);
  savedTokenPresent = changes[savedTokenKey].newValue !== undefined;
  elements.rememberTokenInput.checked = Boolean(rememberedToken);
  if (preferencesReady) renderState(wiper.state);
});

window.addEventListener("message", event => {
  if (!embedded || event.source !== window.parent || event.origin !== parentOrigin || event.data?.bridgeId !== bridgeId) return;
  if (event.data.type === "merrickWiperVisibility" && event.data.visible === false) {
    wiper.pause();
    elements.confirmDialog.close();
  }
  if (event.data.type === "merrickWiperChannel" && channelRequested) {
    channelRequested = false;
    if (["scanning", "ready", "deleting", "stopping"].includes(wiper.state.phase) || acquiring) return;
    if (!isSnowflake(event.data.channelId)) return showError(new WiperError("Open a Discord channel or DM, then select Current."));
    elements.channelInput.value = event.data.channelId;
    clearError();
    persistPreferences();
  }
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !elements.confirmDialog.open) {
    wiper.pause();
    sendToParent("merrickWiperClose");
  }
});
document.addEventListener("visibilitychange", () => { if (document.hidden) wiper.pause(); });
window.addEventListener("pagehide", () => {
  clearTokenField();
  rememberedToken = "";
  sessionSavedToken = "";
  previewWordQuery = "";
  wiper.stop();
  lease.release();
});

renderState(wiper.state);
try {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  const preferences = await loadPreferences(chrome.storage.local);
  elements.minDelayInput.value = preferences.minDelay;
  elements.maxDelayInput.value = preferences.maxDelay;
  elements.speedPresetInput.value = paceFromDelays(preferences.minDelay, preferences.maxDelay);
  elements.rememberChannelInput.checked = preferences.rememberChannel;
  elements.channelInput.value = preferences.channelId;
  applyTheme(preferences.theme);
} catch {
  appendLog("Preferences unavailable. Using defaults; the token will stay in memory.", "warning");
}
try {
  rememberedToken = await tokenStore.load();
  savedTokenPresent = Boolean(rememberedToken);
  elements.rememberTokenInput.checked = savedTokenPresent;
  restoreRememberedToken();
} catch {
  appendLog("Saved token unavailable. Paste a token to keep it in memory only.", "warning");
}
preferencesReady = true;
renderState(wiper.state);
appendLog("Ready. Preview reads history; Start requires confirmation.");
if (embedded && !elements.channelInput.value) requestCurrentChannel();
