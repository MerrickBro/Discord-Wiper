# Privacy

Merrick's Discord Wiper has no backend, analytics, telemetry, advertising, or external account connection.

## Transient data

- Your authorization token exists in an extension-origin input field briefly, then in a private client field while the preview/deletion session is active. The extension sends it only to Discord's canonical HTTPS API in the Authorization header.
- The verified account ID, selected channel ID, candidate message IDs, counts, and recent activity log remain in session memory.
- Discord message bodies are received transiently for filtering. Content, attachments, and recipient names are never displayed, logged, exported, or persisted. Only eligible IDs are retained.

Stop, completion, an execution error, or tab reload/destruction clears the active token and preview. Hiding the panel and pausing preserve the session so it can be resumed; use Stop to discard it. A browser/device administrator or debugger can still inspect memory. Garbage collection controls physical memory reclamation, so the extension cannot promise secure zeroization of JavaScript strings.

## Persistent settings

Extension-local storage contains only delay preferences, light/dark theme, the remember-channel option, and a channel ID when explicitly opted in. Channel remembering is off by default. Unchecking it clears the saved channel ID. This data is not synced by the extension.

No token, account ID, message ID list, message body, or activity log is written to storage. The extension restricts settings access to trusted extension contexts and does not use Discord's localStorage.

## Network

API requests use `https://discord.com/api/v10`. API requests omit cookies, prevent redirects, and disable response caching. Reading Discord's linked policy opens its support website only when you choose that link. Opening the extension from another website may open Discord's web application.

Only bundled JavaScript and styles are used. There is no remote font or CDN dependency.

## Removal

Use Stop to clear an active session. Remove the extension through the browser's extension management page to remove its saved preferences.

Automating a normal Discord user account is forbidden by Discord and may lead to account termination. Rate-limit handling does not eliminate that risk, and messages deleted by Discord cannot be restored by this extension.
