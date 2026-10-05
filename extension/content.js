(() => {
  if (globalThis.merrickWiperMounted) return;
  globalThis.merrickWiperMounted = true;

  const extensionOrigin = chrome.runtime.getURL("").replace(/\/$/, "");
  const bridgeId = crypto.randomUUID();
  const host = document.createElement("div");
  host.id = "merrickDiscordWiper";
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { color-scheme: dark; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    button { position: fixed; right: 18px; bottom: 18px; pointer-events: auto; padding: 12px 17px;
      border: 1px solid #46535b; border-radius: 3px; background: #0f1316; color: #b0e0ff;
      font: 11px "Cascadia Code", Consolas, monospace; cursor: pointer; letter-spacing: .03em;
      box-shadow: 0 8px 30px #0006; }
    button:hover, button:focus-visible { border-color: #b0e0ff; outline: 2px solid #b0e0ff44; }
    iframe { position: fixed; right: 16px; bottom: 16px; width: min(440px, calc(100vw - 32px));
      height: min(790px, calc(100dvh - 32px)); pointer-events: auto; border: 1px solid #46535b;
      border-radius: 4px; background: #0a0d0f; box-shadow: 0 18px 65px #0008; color-scheme: dark; }
    @media (max-width: 480px) { iframe { right: 8px; bottom: 8px; width: calc(100vw - 16px); height: calc(100dvh - 16px); } }
  `;
  const launcher = document.createElement("button");
  launcher.type = "button";
  launcher.textContent = "M // DISCORD WIPER";
  launcher.setAttribute("aria-label", "Open Merrick's Discord Wiper");
  launcher.setAttribute("aria-expanded", "false");
  const frame = document.createElement("iframe");
  frame.title = "Merrick's Discord Wiper";
  frame.referrerPolicy = "no-referrer";
  frame.hidden = true;
  let loaded = false;

  function notifyVisibility() {
    if (loaded) frame.contentWindow?.postMessage({ type: "merrickWiperVisibility", bridgeId, visible: !frame.hidden }, extensionOrigin);
  }

  function setVisible(visible) {
    if (visible && !frame.src) {
      const panelUrl = new URL(chrome.runtime.getURL("panel.html"));
      panelUrl.searchParams.set("parentOrigin", location.origin);
      panelUrl.searchParams.set("bridgeId", bridgeId);
      frame.src = panelUrl.href;
    }
    frame.hidden = !visible;
    launcher.hidden = visible;
    launcher.setAttribute("aria-expanded", String(visible));
    notifyVisibility();
    if (!visible) launcher.focus({ preventScroll: true });
  }

  launcher.addEventListener("click", () => setVisible(true));
  frame.addEventListener("load", () => { loaded = true; notifyVisibility(); });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id === chrome.runtime.id && message?.type === "merrickWiperToggle") {
      setVisible(frame.hidden);
      sendResponse({ ok: true });
    }
  });
  window.addEventListener("message", event => {
    if (event.origin !== extensionOrigin || event.source !== frame.contentWindow || event.data?.bridgeId !== bridgeId) return;
    if (event.data.type === "merrickWiperClose") setVisible(false);
    if (event.data.type === "merrickWiperChannelRequest") {
      const match = /^\/channels\/(?:@me|[1-9]\d{16,19})\/([1-9]\d{16,19})(?:\/|$)/.exec(location.pathname);
      frame.contentWindow.postMessage({ type: "merrickWiperChannel", bridgeId, channelId: match?.[1] ?? "" }, extensionOrigin);
    }
  });
  shadow.append(style, launcher, frame);
  document.documentElement.append(host);
})();
