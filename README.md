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

1. Enter your own authorization token. It is masked by default. Optionally check **Remember token on this device** to restore it on later visits. This stores it in this browser's extension-local storage without encryption by the extension; use a trusted device. Saving never starts a scan or deletion automatically. This extension does not extract Discord's token, inspect its internal application modules, or collect your login details. Never share a real token in issues, chats, or screenshots.
2. Enter the channel or DM ID, or choose **Current** while that conversation is open. To copy IDs manually, enable Discord's **Developer Mode**, then use the conversation's **Copy Channel ID** command. The final numeric component of a Discord conversation URL is also its channel ID.
3. Optionally expand **Filters** to enable dates, multiple words, **Keep pinned messages**, or attachments. All start off on a new panel or reload; filter values are not saved. See the matching rules below.
4. Choose **Balanced** (**1,000–2,000 ms**) or **Faster** (**500–750 ms**), or enter custom delays from **250–60,000 ms**. Equal values give a fixed delay. Existing delay preferences are preserved. Discord cooldowns always take precedence; a `429` also temporarily increases request pacing. Actual throughput depends on API response times and Discord's limits.
5. Read and acknowledge the account/deletion warning, then choose **Preview**. This verifies the token's author ID using `/users/@me`, verifies the selected channel, and scans accessible history without deleting anything.
6. Review the eligible count, account ID, active filter summary, and number of own messages excluded by filters. Choose **Start**, review the frozen filter settings, type the exact channel ID, and explicitly confirm permanent deletion.
7. Use **Pause / Resume** to control the next request. **Stop** aborts waits and active fetches and discards the preview. A remembered token is kept and restored in the masked input; memory-only tokens are cleared. **Forget** removes the saved copy, clears the current input, and stops this panel's session. A request already sent to Discord may still complete on the server.

Hiding the panel or switching away from its tab pauses active work. Reopening it never resumes deletion automatically. Closing/reloading the tab clears the active session but preserves an opted-in saved token. Every new run still needs a new preview and deletion confirmation. A `401` removes the rejected saved token if it still matches this run's saved value; it does not erase a newer replacement saved in another panel. If storage removal fails, the panel shows a warning and asks you to use Forget.

Unchecking **Remember token** removes the saved copy while leaving the current input available in memory. A replacement token is saved when you check Remember or create a new preview. Other open panels may still hold a previously entered token in memory; close them or use Stop/Forget there to end their sessions.

The preview is a frozen list of eligible message IDs. Messages posted after the preview are excluded; create a fresh preview to include them. Word and attachment matches are evaluated during preview; later edits do not change the frozen list. With **Keep pinned messages**, pin status is also checked before each deletion. A preview with no eligible messages clears its active client token. History is read in pages of up to 100, including messages from other authors. A page without filter matches does not end the scan.

## Optional filters

| Filter | Eligible messages |
| --- | --- |
| Date: **Before** | Created before the start of the selected day; that day is excluded |
| Date: **After** | Created after the selected day finishes; that day is excluded |
| Date: **During** | Created on any day in the From/Through range, including both selected days |
| Date: **Except** | Created outside that inclusive date range; messages inside it are protected |
| Words: **Containing** | Text matches the selected Match any / Match all rule |
| Words: **Excluding** | Text does not match that rule; matching messages are protected |
| **Keep pinned messages** | Unpinned during preview and still unpinned when checked before deletion |
| Attachments: **Containing** | Has at least one attachment of the selected type |
| Attachments: **Excluding** | Has no attachment of that type; messages with it are protected |

Dates use the message ID's immutable creation timestamp and the device's local timezone at preview time. The timezone appears in the preview and confirmation. Date ranges include complete calendar days, including daylight-saving changes; choose the same From and Through date for a single day. Empty, invalid, and reversed enabled ranges are rejected before any API request.

Date previews use exact message-ID boundaries to skip unrelated history. Before/During jump to the upper boundary; After/During stop at the lower boundary. Except scans the newer window, then jumps past the excluded range into the older window. Boundary pages can contain some out-of-range messages, which are still checked and excluded. Scanned and excluded counts cover messages actually fetched, not history skipped by date bounds. Other filters still require reading the selected history; the account, channel, and owner checks remain in place.

Enter up to **32 words or phrases**, one per line, with up to **256 characters per term**. Blank lines are ignored and case-equivalent duplicates are combined. **Match any** requires at least one term; **Match all** requires every term. Excluding negates the whole rule: Excluding + Match all protects messages containing all the listed terms, while messages containing only some remain eligible. Commas, spaces, and punctuation inside a line are literal; there are no regular expressions or searches of attachment names/embeds.

Words are case-insensitive substrings by default, so `cat` matches `cats`. **Whole words only** requires word boundaries around each term or phrase, so `cat` no longer matches `cats` or `bobcat`. Unicode letters, combining marks, numbers, and underscores count as word characters. Empty message text passes Excluding, but not Containing. Missing or malformed text stops an enabled word-filter scan without offering a partial preview.

Attachment types are **Any attachment**, **Images / GIFs**, **Videos**, **Audio / voice**, and **Other files**. Classification uses media MIME types first, then known filename extensions; other attachments count as files. Linked previews and embeds do not count, and files are never downloaded. A mixed message with an image and a document is protected by Excluding images. Missing or malformed attachment metadata stops an enabled attachment-filter scan without offering a partial preview.

**Keep pinned messages** excludes pins during preview and adds one paced GET for each selected message before its DELETE. Newly pinned messages are counted as kept; messages already absent are counted separately without DELETE. An unreadable pin status or changed ownership/channel stops execution. These extra requests can slow deletion. A pin can still change between the check and DELETE because those requests are separate.

Every enabled filter must match, along with the verified-owner/type checks. Controls lock during scanning, preview confirmation, and deletion. Use Stop and create a new preview to change them. Hiding/reopening the same panel preserves its values; a new panel or reload resets filters to off. Filter inputs remain in panel memory and are not synced, logged, or saved in preferences.

## Session timing

**Elapsed** shows wall time since Preview, including pauses and confirmation time. **Processed / min** measures deletion progress, including already-absent messages and late pins kept; pauses are excluded and cooldowns are included. **Remaining** appears after at least three processed messages and estimates active deletion time using observed progress and any current cooldown. It changes as response times and rate limits change. Preview history has no known total, so its remaining time is not estimated. Timing freezes when the session ends and resets on a new preview.

## Privacy and permissions

- Tokens stay in private JavaScript memory inside an **extension-origin iframe** by default. They are sent only as `Authorization` headers to `https://discord.com/api/v10`. They never enter Discord's DOM, URL parameters, `postMessage`, logs, or web `localStorage`.
- **Remember token** explicitly permits a token-only entry in `chrome.storage.local`. Access is restricted to trusted extension contexts before reading or writing credentials. It is not synced by the extension or encrypted by this extension. Forget removes the stored entry; it cannot guarantee physical erasure from browser/device backups or memory.
- Non-sensitive delay/theme preferences use a separate allowlisted settings entry. The channel ID is saved only if **Remember this channel** is checked; unchecking it removes the saved channel ID. No account IDs, message lists, message bodies, or activity logs are persisted.
- There is no server, telemetry, analytics, remote script, or Discord login integration. Raw Discord message bodies are read transiently for filtering and never displayed or persisted. Only eligible message IDs remain in memory for the preview, capped at 100,000.
- Permissions are limited to extension settings storage and the three Discord web origins. The content script mounts/toggles the panel and supplies the current channel ID. It cannot request deletion or receive the token. The service worker only handles the toolbar button and storage access level.
- A Web Lock allows only one active extension session per browser storage partition, including while a preview awaits confirmation. Different browser profiles, private windows, storage partitions, and unrelated tools are outside this lock.

Memory-only handling reduces exposure; it cannot protect against a compromised browser/device or privileged debugging. JavaScript strings cannot be guaranteed to be physically zeroed in memory. Stop clears the active engine's credential references; opting into remembering intentionally retains a saved token and a masked input for reuse. Forget removes those references in this panel and its stored entry.

## Behavior and limitations

The extension serializes every HTTP request. It applies the selected delay after each response, honors exhausted-bucket reset headers, reads `Retry-After` / JSON `retry_after` on `429`, and treats global cooldowns as a barrier across the entire session. It adds a 250 ms timing margin and has bounded retries for rate limits, connection failures, and server errors. This is rate-limit compliance, not an attempt to conceal automation.

A `429` doubles the adaptive pacing floor, starting at twice the selected minimum and capped at 60 seconds. After five successful responses, the floor halves and eventually returns to the chosen preset. This never shortens an advertised Discord cooldown, and all requests remain serialized.

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

The package command creates `dist/merrick-discord-wiper-0.4.0.zip`. The ZIP contains the ready-to-load extension, this README, and the architecture/privacy notes. It excludes tests, development artifacts, and any session state.

`npm test` uses fictional tokens and mocked API responses. Coverage includes pagination/ownership, date-window equivalence and request savings, midnight/daylight-saving boundaries, multiple-word and whole-word rules, attachment metadata, late pin checks, timing/cooldowns, confirmation, stop/pause, rate limits, token storage, settings sanitization, and session exclusion. Panel-flow tests run the real panel module with mocked DOM/storage/clock/API surfaces to verify combined filters, locked confirmation, default-off controls, timing, and saved-token behavior. No real Discord account or messages are used. `npm run check` validates syntax, local imports/resources, permissions, and the release file set.

An optional Chromium smoke test is available with Playwright installed and its Chromium browser downloaded:

```sh
npm install --no-save --package-lock=false playwright@1.62.1
npx playwright install chromium
npm run test:browser
```

It sideloads the actual extension, intercepts every Discord request, uses a fictional token/account, and checks UI, preview/confirmation, rate-limit/pause/resume flow, cross-tab exclusion, and storage. It never contacts a real Discord account.

The GitHub Actions workflow runs the core checks and this browser test against the extracted release ZIP. It also checks Stop, authentication errors, empty history, reload behavior, token persistence/removal, small-screen layout, and the PTB/Canary clients. The workflow saves the installable ZIP and UI screenshots as downloadable artifacts.

## Update an unpacked installation

Stop any active run, replace the files in your existing unpacked extension folder with the new ZIP's contents, then select **Reload** on the browser's extensions page and reload Discord. Keep the same folder path and extension installation to preserve existing preferences and an opted-in token. Removing the extension clears its local data.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the state machine and module contracts, and [docs/PRIVACY.md](docs/PRIVACY.md) for data handling.

## Primary references

- [Discord self-bot policy](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots)
- [Discord rate limits](https://docs.discord.com/developers/topics/rate-limits)
- [Discord message resource](https://docs.discord.com/developers/resources/message)
- [Discord snowflake timestamps](https://docs.discord.com/developers/reference#snowflakes)
- [Chrome cross-origin extension requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
- [Chrome extension storage](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [Undiscord](https://github.com/victornpb/undiscord)

Implementation does not provide any guarantee against account termination or restore deleted messages.
