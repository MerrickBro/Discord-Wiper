import { MessageWiper } from "./core/wiper.js";
import { SessionLease } from "./core/sessionLease.js";
import { loadPreferences, savePreferences } from "./core/preferences.js";
import { discordOrigins, isSnowflake, safeErrorMessage, validateChannelId, validateDelays, validateToken, WiperError } from "./core/validation.js";

const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map(element => [element.id, element]));
const parentOrigin = new URL(location.href).searchParams.get("parentOrigin");
const bridgeId = new URL(location.href).searchParams.get("bridgeId");
const embedded = window.parent !== window && discordOrigins.includes(parentOrigin) && Boolean(bridgeId);
const lease = new SessionLease();
let acquiring = false;
let stopping = false;
let channelRequested = false;
let waitTimer = null;
let savedTheme = "dark";
let preferencesReady = false;

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
  if (state.phase === "complete") detail = `Finished · ${state.deleted.toLocaleString()} deleted · ${state.alreadyGone.toLocaleString()} already absent · ${state.skipped.toLocaleString()} unsupported own messages skipped. Token cleared.`;
  if (state.phase === "stopped") detail = "Token and preview cleared. A request already sent may have finished.";
  if (state.phase === "stopping") detail = "Stopping requests and clearing the token. An already-sent deletion may finish.";
  if (state.phase === "error") detail = state.error;
  if (state.paused) detail = "Waiting for Resume. A request already sent may finish. Discord cooldowns remain in effect.";
  else if (waiting) detail = `${state.waitReason}: ${Math.max(0, (state.waitUntil - Date.now()) / 1000).toFixed(1)} s remaining. ${state.phase === "scanning" ? "Preview only." : "Deletion will continue after the wait."}`;
  elements.statusDetail.textContent = detail;
}

function renderState(state) {
  updateStatus(state);
  const locked = acquiring || stopping || ["scanning", "ready", "deleting", "stopping"].includes(state.phase);
  const active = ["scanning", "deleting"].includes(state.phase);
  for (const name of ["tokenInput", "channelInput", "minDelayInput", "maxDelayInput", "rememberChannelInput", "riskInput", "showTokenButton", "currentChannelButton"]) {
    elements[name].disabled = locked || !preferencesReady;
  }
  elements.tokenInput.placeholder = locked ? "Token held in session memory" : "Paste your own account token";
  elements.previewButton.disabled = locked || !preferencesReady;
  elements.startButton.disabled = state.phase !== "ready" || stopping;
  elements.pauseButton.disabled = !active || stopping;
  elements.pauseButton.textContent = state.paused ? "Resume" : "Pause";
  elements.stopButton.disabled = acquiring || stopping || (!locked && !elements.tokenInput.value);
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
  if (acquiring || ["scanning", "ready", "deleting", "stopping"].includes(wiper.state.phase)) return;
  clearError();
  let options;
  try {
    if (!elements.riskInput.checked) throw new WiperError("Acknowledge the account and permanent deletion risks before making API requests.");
    options = { token: validateToken(elements.tokenInput.value), channelId: validateChannelId(elements.channelInput.value),
      ...validateDelays(Number(elements.minDelayInput.value), Number(elements.maxDelayInput.value)) };
    acquiring = true;
    renderState(wiper.state);
    await lease.acquire();
    await persistPreferences();
    clearTokenField();
    acquiring = false;
    const task = wiper.preview(options);
    options.token = "";
    await task;
  } catch (error) {
    clearTokenField();
    if (!wiper.state.error && wiper.state.phase !== "stopped") showError(error);
  } finally {
    if (options) options.token = "";
    acquiring = false;
    if (wiper.state.phase !== "ready") await lease.release();
    renderState(wiper.state);
  }
});

elements.startButton.addEventListener("click", () => {
  if (wiper.state.phase !== "ready") return;
  elements.confirmDescription.textContent = `This permanently deletes ${wiper.state.matched.toLocaleString()} messages from your verified account in this channel. Messages sent after the preview are excluded.`;
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
    if (!wiper.state.error && wiper.state.phase !== "stopped") showError(error);
  } finally {
    elements.confirmationInput.value = "";
    elements.permanentInput.checked = false;
    await lease.release();
    renderState(wiper.state);
  }
});

elements.pauseButton.addEventListener("click", () => { wiper.state.paused ? wiper.resume() : wiper.pause(); });
elements.stopButton.addEventListener("click", async () => {
  if (stopping || acquiring) return;
  stopping = true;
  clearTokenField();
  elements.confirmDialog.close();
  clearError();
  renderState(wiper.state);
  await wiper.stop();
  await lease.release();
  stopping = false;
  renderState(wiper.state);
});
elements.tokenInput.addEventListener("input", () => renderState(wiper.state));
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
for (const name of ["minDelayInput", "maxDelayInput", "channelInput", "rememberChannelInput"]) elements[name].addEventListener("change", persistPreferences);

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
  wiper.stop();
  lease.release();
});

renderState(wiper.state);
try {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  const preferences = await loadPreferences(chrome.storage.local);
  elements.minDelayInput.value = preferences.minDelay;
  elements.maxDelayInput.value = preferences.maxDelay;
  elements.rememberChannelInput.checked = preferences.rememberChannel;
  elements.channelInput.value = preferences.channelId;
  applyTheme(preferences.theme);
} catch {
  appendLog("Preferences unavailable. Using defaults; the token will stay in memory.", "warning");
}
preferencesReady = true;
renderState(wiper.state);
appendLog("Ready. Preview reads history; Start requires confirmation.");
if (embedded && !elements.channelInput.value) requestCurrentChannel();
