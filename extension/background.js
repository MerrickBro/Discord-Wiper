async function protectStorage() {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
}

protectStorage().catch(() => {});
chrome.runtime.onInstalled.addListener(() => { protectStorage().catch(() => {}); });

chrome.action.onClicked.addListener(async tab => {
  if (!tab.id || !/^https:\/\/(?:ptb\.|canary\.)?discord\.com\//.test(tab.url ?? "")) {
    await chrome.tabs.create({ url: "https://discord.com/channels/@me" });
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "merrickWiperToggle" });
    await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
    await chrome.action.setTitle({ tabId: tab.id, title: "Open Merrick's Discord Wiper" });
  } catch {
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#f0bd80" });
    await chrome.action.setBadgeText({ tabId: tab.id, text: "!" });
    await chrome.action.setTitle({ tabId: tab.id, title: "Reload Discord to activate Merrick's Discord Wiper" });
  }
});
