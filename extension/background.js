const discordUrlPattern = /^https:\/\/(?:ptb\.|canary\.)?discord\.com\//;

async function protectStorage() {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
}

async function clearActionStatus(tabId) {
  await chrome.action.setBadgeText({ tabId, text: "" });
  await chrome.action.setTitle({ tabId, title: "Open Merrick's Discord Wiper" });
}

async function setActivationError(tabId) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#f0bd80" });
  await chrome.action.setBadgeText({ tabId, text: "!" });
  await chrome.action.setTitle({ tabId, title: "Could not activate Merrick's Discord Wiper on this tab" });
}

async function toggleWiper(tab) {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content.js"]
  });
  await chrome.tabs.sendMessage(tab.id, { type: "merrickWiperToggle" });
  await clearActionStatus(tab.id);
}

protectStorage().catch(() => {});
chrome.runtime.onInstalled.addListener(() => { protectStorage().catch(() => {}); });

chrome.action.onClicked.addListener(async tab => {
  if (!tab.id || !discordUrlPattern.test(tab.url ?? "")) {
    await chrome.tabs.create({ url: "https://discord.com/channels/@me" });
    return;
  }

  try {
    await toggleWiper(tab);
  } catch {
    await setActivationError(tab.id);
  }
});
