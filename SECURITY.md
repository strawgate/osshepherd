# Security Architecture

This document describes the trust model for OSShepherd, known risks, and the reasoning behind
our message-passing and storage validation decisions.

---

## Trust Tier Hierarchy

Chrome extensions have four distinct execution contexts, ranked from most to least trusted:

| Tier | Context | Key constraint |
|------|---------|---------------|
| 1 (highest) | Background service worker (`background.js`) | Owns all privileged operations; only context with full `chrome.*` API access |
| 2 | Extension pages (`sidepanel.html`, `options.html`, `popup.html`) | Trusted — same origin, but no `sender.tab`; can only be opened by the browser or the background |
| 3 | Offscreen document (`offscreen.html`) | Extension origin; has access to `chrome.runtime` and to other `chrome.*` APIs granted by manifest permissions (actual breadth expands with Chrome version); used only for WebSocket I/O in this extension |
| 4 (lowest) | Content scripts (`content.js`) | Run inside the web page's renderer process; the extension's biggest attack surface |

Content scripts are treated as untrusted input because they share a process with arbitrary web
pages. A cross-site scripting bug on GitHub — or any site the user visits — could in principle
compromise a content script. We design as if a content script may be controlled by an attacker.

---

## Message Passing — Broadcast Model

`chrome.runtime.sendMessage` is a **broadcast**: every extension context that has a
`chrome.runtime.onMessage` listener receives the message.
`chrome.tabs.sendMessage` is the only way to target a specific content script.

Consequence: any message handler that takes a privileged action **must validate who sent it**,
not just what the message says.

### How we validate senders

**Content script → background (`OPEN_SIDEPANEL`, `REQUEST_REVIEW`)**
We ignore `request.payload` entirely for identifying the PR. Instead we parse
`sender.tab.url` — the URL Chrome verified for the sender's tab. A content script cannot
forge this field. If the URL does not match the GitHub PR pattern we reject the request.

**Side panel → background (`REQUEST_REVIEW`)**
The side panel has no `sender.tab`. We verify `sender.id === chrome.runtime.id` (same
extension) as the primary trust check, then additionally require `sender.url` to match
`sidepanel.html` to restrict the handler to that specific page. PR identity is then looked up
from `chrome.storage.session` (written by the background at `OPEN_SIDEPANEL` time from a
verified tab URL). The side panel payload only supplies a `tabId` as a lookup key; it cannot
inject PR identity.

**Options page → background (`START_OAUTH_LOGIN`)**
`sender.id === chrome.runtime.id` is the primary check; `sender.url` must additionally match
`options.html`. Only the options page should be able to trigger an OAuth flow.

**Offscreen document → background (`REVIEW_EVENT`, `REVIEW_COMPLETE`, `REVIEW_ERROR`)**
`sender.id === chrome.runtime.id` is the primary check; `sender.url` must additionally match
`offscreen.html`.

**Background → offscreen (`START_OFFSCREEN_REVIEW`)**
Validated inside `offscreen.js` using `sender.id === chrome.runtime.id && !sender.tab`.
We do **not** check `sender.url` here because Chrome does not reliably set `sender.url` for
background service worker messages. `sender.tab` being present means the sender is a content
script (always untrusted for this message type).

### Sender field reliability: `sender.id`, `sender.origin`, and `sender.url`

**`sender.id`** is the extension ID and is set for all extension contexts including content
scripts. It is the primary trust anchor — a wrong `sender.id` means the message came from a
different extension.

**`sender.origin`** is `chrome-extension://<id>` for all extension contexts. Chrome's own
docs list it as more resistant to spoofing in compromised-renderer scenarios than `sender.url`
(added Chrome 80). It is equivalent to `sender.id` for our trust decisions since all extension
pages share the same origin.

**`sender.url`** is the full URL of the sending extension page. It is reliably set for
extension pages (`popup.html`, `sidepanel.html`, `options.html`, `offscreen.html`) and is used
as a secondary check to restrict specific message types to the correct page. It is **not**
checked in isolation — `sender.id` must pass first. `sender.url` is **not** checked for
service worker senders because Chrome may leave it unset for that context.

---

## Storage Security

**`chrome.storage.session`** — default `AccessLevel: TRUSTED_CONTEXTS` blocks direct content
script access. We use it for `sidepanel:context:<tabId>` (authoritative PR identity). Known
Chromium bug 1342046 causes `onChanged` events to fire in content scripts even when access is
restricted; we treat the data as read-only context (no secrets stored here).

**`chrome.storage.local`** — accessible to content scripts by default. We store the GitHub
OAuth token and CodeRabbit token here. A compromised content script could read these tokens.
Accepted risk — Chrome extensions have no per-context storage isolation for `local`. We
mitigate by never passing tokens in message payloads; the background reads them directly from
storage when needed.

**Token display** — the options page shows `[set]` or `NOT SET` rather than any portion of
the token values.

---

## Output Sanitisation (Markdown Renderer)

`src/utils/markdown.js` renders CodeRabbit's AI output into the side panel. Key protections:

- `<div>` is **not** in the block-HTML pass-through allowlist, preventing arbitrary HTML injection via div wrappers.
- All pass-through block HTML tags (`<details>`, `<summary>`, tables) are sanitised to strip `on*` event handlers and `style` attributes (quoted and unquoted).
- URL-bearing attributes (`href`, `src`, `action`, `formaction`, `background`, `poster`, `cite`, `ping`) in pass-through HTML are validated against the same scheme allowlist; attributes with disallowed schemes are stripped entirely.
- Link URLs are validated against a scheme **allowlist** (`https?`, `mailto`, `tel`, `ftp`, relative paths, `data:image/*`) rather than a blocklist. Schemes not in the list produce an empty `href`.

---

## Accepted / Known Risks

| Risk | Rationale |
|------|-----------|
| `chrome.storage.local` tokens readable by content scripts | No available mitigation within MV3; background never forwards raw tokens in messages |
| `storage.session` `onChanged` leaks to content scripts (Chromium bug 1342046) | Session data contains only PR identity (owner/repo/number), not secrets |
| `sender.url` forgeable under compromised-renderer attack | `sender.url` is a secondary check only; `sender.id` is the primary guard. Threat model is confused-deputy, not compromised renderer; accepted |
| CodeRabbit API auth (token scoping, server-side validation) | Server-side; outside our control |
