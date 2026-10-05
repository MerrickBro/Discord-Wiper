# Merrick's Discord Wiper

A compact Manifest V3 extension that previews and deletes **your own** Discord messages in a selected channel, thread, or DM. The panel lives inside Discord's web application and follows the Merrick Tools interface: simple fields, blue accents, light/dark themes, and a bounded activity log.

**Automating a normal user account violates Discord's Terms of Service and self-bot policy. Discord may terminate the account. Request delays and rate-limit handling cannot make this activity permitted or guarantee protection against bans. Deletion is permanent.**

This is an independent utility, not an official Discord application. Use only an account you own. It is inspired by Undiscord's workflow; its implementation is original and does not bundle Undiscord code.

## Install on Windows / Chromium

1. Download the packaged ZIP and extract it.
2. Open `chrome://extensions` in Chrome, `edge://extensions` in Edge, or `opera://extensions` in Opera / Opera GX.
3. Enable **Developer mode**, choose **Load unpacked**, and select the extracted `merrick-discord-wiper` folder containing `manifest.json`. If installing from the repository, select its `extension` folder instead.
4. Open or reload Discord at `https://discord.com/channels/@me`.
5. Click **M // DISCORD WIPER** in the bottom-right corner, or the extension's toolbar icon.

Firefox and the Discord desktop application are not supported by this package. The extension supports Discord's regular, PTB, and Canary web clients; all API requests use the canonical `discord.com` API.

## Use

1. Enter your own authorization token. It is masked by default. This extension does not extract Discord's token, inspect its internal application modules, or collect your login details. Never share a real token in issues, chats, or screenshots.
2. Enter the channel or DM ID, or choose **Current** while that conversation is open. To copy IDs manually, enable Discord's **Developer Mode**, then use the conversation's **Copy Channel ID** command. The final numeric component of a Discord conversation URL is also its channel ID.
3. Set minimum and maximum request delays. Defaults are **1,000–2,000 ms**, and the allowed range is **1,000–60,000 ms**. Equal values give a fixed delay. Discord cooldowns always take precedence over shorter settings.
4. Read and acknowledge the account/deletion warning, then choose **Preview**. This verifies the token's author ID using `/users/@me`, verifies the selected channel, and scans accessible history without deleting anything.
5. Review the eligible count and account ID. Choose **Start**, type the exact channel ID, and explicitly confirm permanent deletion.
6. Use **Pause / Resume** to control the next request. **Stop** aborts waits and active fetches, discards the preview, and clears the token. A request already sent to Discord may still complete on the server.

Hiding the panel or switching away from its tab pauses active work. Reopening it never resumes deletion automatically. Closing/reloading the tab clears the session. After a stop or error, enter the token again and create a new preview.

The preview is a frozen list of eligible message IDs. Messages posted after the preview are excluded; create a fresh preview to include them. A preview with no eligible messages clears its token automatically. Large histories take time because the extension reads all accessible channel messages in pages of 100, including messages from other authors.

## Privacy and permissions

- Tokens stay in private JavaScript memory inside an **extension-origin iframe**. They are sent only as `Authorization` headers to `https://discord.com/api/v10`. They never enter Discord's DOM, URL parameters, `postMessage`, logs, `localStorage`, or extension storage.
- Non-sensitive delay/theme preferences use extension `chrome.storage.local`, restricted to trusted extension contexts. The channel ID is saved only if **Remember this channel** is checked; unchecking it removes the saved channel ID. No credentials, account IDs, message lists, or activity logs are persisted.
- There is no server, telemetry, analytics, remote script, or Discord login integration. Raw Discord message bodies are read transiently for filtering and never displayed or persisted. Only eligible message IDs remain in memory for the preview, capped at 100,000.
- Permissions are limited to extension settings storage and the three Discord web origins. The content script mounts/toggles the panel and supplies the current channel ID. It cannot request deletion or receive the token. The service worker only handles the toolbar button and storage access level.
- A Web Lock allows only one active extension session per browser storage partition, including while a preview awaits confirmation. Different browser profiles, private windows, storage partitions, and unrelated tools are outside this lock.

Memory-only handling reduces exposure; it cannot protect against a compromised browser/device or privileged debugging. JavaScript strings cannot be guaranteed to be physically zeroed in memory. Clearing removes this extension's references and prevents further authenticated requests.

## Behavior and limitations

The extension serializes every HTTP request. It applies the selected delay after each response, honors exhausted-bucket reset headers, reads `Retry-After` / JSON `retry_after` on `429`, and treats global cooldowns as a barrier across the entire session. It adds a 250 ms timing margin and has bounded retries for rate limits, connection failures, and server errors. This is rate-limit compliance, not an attempt to conceal automation.

`401`, `403`, verification challenges, invalid pagination, unknown channels, malformed responses, and unexpected deletion responses stop execution. A DELETE `404` with Discord code `10008` means the message is already absent and is counted separately. A network interruption can obscure whether a deletion succeeded before the retry; an already-absent count does not prove this run had no effect on that message.

Only messages authored by the ID returned from the token's `/users/@me` response are eligible. Webhooks and unsupported/system-only message types are skipped. The account is checked again before deletion. Each eligible message uses a separate DELETE request; the bot-only bulk-delete endpoint is not used. Old messages can be attempted individually, subject to Discord's actual permissions and endpoint behavior.

An empty history response can also indicate missing `READ_MESSAGE_HISTORY` permission. The utility cannot reach deleted, inaccessible, or closed conversations without a usable channel ID and API access. A guild channel scan does not recursively scan its threads. Supply each thread's own channel ID separately. There is no all-server/all-DM discovery or automatic retry across reloads.

Discord's published developer endpoints primarily describe supported bot/OAuth applications. They do not authorize user-token automation or promise continued compatibility with it. Endpoint behavior may change.

## Develop and verify

Node.js 20+ and Python 3 are sufficient; the extension has no build step or runtime dependencies.

```sh
npm test
npm run check
npm run package
```

The package command creates `dist/merrick-discord-wiper-0.1.0.zip`. The ZIP contains the ready-to-load extension, this README, and the architecture/privacy notes. It excludes tests, development artifacts, and any session state.

`npm test` runs mocked API tests for pagination, author filtering, confirmation, rate-limit responses, global waits, error handling, stop/pause behavior, settings sanitization, and session exclusion. No real Discord account or messages are used. `npm run check` validates JavaScript syntax, local imports/resources, permissions, and the release file set.

An optional Chromium smoke test is available with Playwright installed and its Chromium browser downloaded:

```sh
npm install --no-save --package-lock=false playwright@1.62.1
npx playwright install chromium
npm run test:browser
```

It sideloads the actual extension, intercepts every Discord request, uses a fictional token/account, and checks UI, preview/confirmation, rate-limit/pause/resume flow, cross-tab exclusion, and storage. It never contacts a real Discord account.

The GitHub Actions workflow runs the core checks and this browser test against the extracted release ZIP. It also checks Stop, authentication errors, empty history, reload behavior, small-screen layout, and the PTB/Canary clients. The workflow saves the installable ZIP and UI screenshots as downloadable artifacts.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the state machine and module contracts, and [docs/PRIVACY.md](docs/PRIVACY.md) for data handling.

## Primary references

- [Discord self-bot policy](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots)
- [Discord rate limits](https://docs.discord.com/developers/topics/rate-limits)
- [Discord message resource](https://docs.discord.com/developers/resources/message)
- [Chrome cross-origin extension requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
- [Chrome extension storage](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [Undiscord](https://github.com/victornpb/undiscord)

Implementation does not provide any guarantee against account termination or restore deleted messages.
