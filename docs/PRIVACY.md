# Privacy

Merrick's Discord Wiper has no backend, analytics, telemetry, advertising, or external account connection.

The extension does not register an automatically running content script. Discord pages are left untouched until you click the extension's toolbar icon on that tab. Reloading or navigating away removes that injected page bridge and another toolbar click is required to activate it again.

## Transient data

- By default, your authorization token exists only in an extension-origin input field and a private client field while the preview/deletion session is active. If remembering is enabled, the panel also keeps a private remembered-value reference and restores the masked input between runs. The extension sends tokens only to Discord's canonical HTTPS API in the Authorization header.
- The verified account ID, selected channel ID, candidate message IDs, counts, and recent activity log remain in session memory.
- Discord message bodies are received transiently for filtering. Content, attachments, and recipient names are never displayed, logged, exported, or persisted. Only eligible IDs are retained.
- Optional date, word, pin, and attachment settings exist only in panel memory. Typed words/phrases appear in deletion confirmation but never in logs, core state, or storage. Attachment metadata is read transiently to classify files; attachments are never downloaded. Filters start off on each new panel or reload; hiding the same panel preserves values.
- Elapsed time, observed processing rate, remaining-time estimates, and kept-pin counts are session-only. Pin protection reads each selected message again before deletion; its content and attachments are not retained.

Stop, completion, an execution error, or tab reload/destruction clears the active engine token and preview. An opted-in saved token is preserved, except when rejected with `401`. Hiding the panel and pausing preserve the session so it can be resumed; use Stop to discard it. A browser/device administrator or debugger can still inspect memory. Garbage collection controls physical memory reclamation, so the extension cannot promise secure zeroization of JavaScript strings.

## Persistent settings

Extension-local storage contains only delay preferences, light/dark theme, the remember-channel option, and a channel ID when explicitly opted in. Channel remembering is off by default. Unchecking it clears the saved channel ID. This data is not synced by the extension.

Token saving is off by default. **Remember token on this device** explicitly saves one token in a separate extension-local entry. The extension does not encrypt this value or sync it to other browsers. Anyone with sufficient browser/device/debugging access may be able to read it. Use this option only on a trusted device.

Storage access is restricted to trusted extension contexts before any credential read or write. The content script does not get storage access. No account ID, message ID list, message body, activity log, filter dates, search terms, matching mode, pin/attachment flags, or timing metrics are saved. Discord's localStorage is never used.

Unchecking Remember token deletes the saved entry and keeps the existing input in memory. **Forget** deletes the stored entry, clears this panel's input/private remembered value, and stops this panel's active session. Other already-open panels may retain credentials in memory until their sessions are stopped or their pages are closed. Deleting an entry cannot guarantee physical erasure from device/browser backups.

When Discord rejects an active saved token with `401`, the panel removes the saved entry only if it still contains that rejected token. A newer replacement is preserved. Storage-removal failures are reported and require another Forget attempt.

## Network

API requests use `https://discord.com/api/v10`. API requests omit cookies, prevent redirects, and disable response caching. Reading Discord's linked policy opens its support website only when you choose that link. Opening the extension from another website may open Discord's web application.

Only bundled JavaScript and styles are used. There is no remote font or CDN dependency.

## Removal

Use Stop to clear an active session, or Forget to also remove its saved token. Remove the extension through the browser's extension management page to remove its saved local data.

Automating a normal Discord user account is forbidden by Discord and may lead to account termination. Rate-limit handling does not eliminate that risk, and messages deleted by Discord cannot be restored by this extension.
