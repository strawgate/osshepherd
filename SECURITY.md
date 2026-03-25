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

Content scripts are treated as untrusted input because they interact with arbitrary web page
DOM. A cross-site scripting bug on GitHub — or any site the user visits — can inject malicious
content into the page DOM that a content script might read, allowing an attacker to influence
the messages the content script sends (confused-deputy threat). We design as if a content
script's messages may be adversarially crafted.

Full renderer process compromise (a V8/Chromium exploit that breaks world isolation between
the page and the content script's isolated world) is a separate, deeper threat and is an
accepted risk beyond our control surface.

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

`src/utils/markdown.js` renders CodeRabbit's AI output into the side panel.

**Trust level:** CodeRabbit's review output is a known, controlled source — not arbitrary user-submitted content. The sanitisation here is **defense-in-depth**, not the primary security boundary. The main reason to sanitise at all is that CodeRabbit's AI may reproduce verbatim content from PR code or comments, which are untrusted third-party text.

Protections in place:

- `<div>` is **not** in the block-HTML pass-through allowlist, preventing arbitrary HTML injection via div wrappers.
- All pass-through block HTML tags (`<details>`, `<summary>`, tables) are sanitised to strip `on*` event handlers and `style` attributes (quoted and unquoted).
- URL-bearing attributes (`href`, `src`, `action`, `formaction`, `background`, `poster`, `cite`, `ping`) in pass-through HTML are validated against a scheme allowlist; attributes with disallowed schemes are stripped. Normal `https://` URLs pass through unchanged.
- `data:image/svg+xml` is rejected — SVG data URLs can embed `<script>` and event handlers. Only raster MIME types (`data:image/png`, `data:image/jpeg`, `data:image/gif`, `data:image/webp`) are permitted.
- Link URLs are validated against a scheme **allowlist** (`https?`, `mailto`, `tel`, `ftp`, relative paths). Schemes not in the list produce an empty `href`.

---

## Accepted / Known Risks

| Risk | Rationale |
|------|-----------|
| `chrome.storage.local` tokens readable by content scripts | No available mitigation within MV3; background never forwards raw tokens in messages |
| `storage.session` `onChanged` leaks to content scripts (Chromium bug 1342046) | Session data contains only PR identity (owner/repo/number), not secrets |
| Full renderer process compromise (V8/Chromium exploit breaking world isolation) | Outside our control surface; `sender.id` + tab-URL guards still cover the confused-deputy layer. Accepted risk. |
| CodeRabbit API auth (token scoping, server-side validation) | Server-side; outside our control |

---

## Content Security Policy (CSP)

MV3 extensions enforce a strict default CSP that cannot be weakened by the extension:

- `script-src 'self'` — only scripts bundled in the extension package may execute; no `eval()`, no `new Function()`, no inline `<script>` blocks.
- `object-src 'self'` — no external plugins or embeds.

This extension does **not** define a custom `content_security_policy` key in `manifest.json`, so the MV3 defaults apply in full.

### What this means for the extension

- All JavaScript (`background.js`, `sidebar.js`, `content.js`, etc.) must be packaged files — no remote scripts.
- The custom markdown renderer (`src/utils/markdown.js`) converts AI output to HTML via string manipulation rather than `eval`, consistent with the `script-src 'self'` constraint.
- Outbound network connections to `https://ide.coderabbit.ai/*`, `https://app.coderabbit.ai/*`, and `wss://ide.coderabbit.ai/*` are declared in `host_permissions` and initiated only from the background service worker and offscreen document — never from content scripts.

### Verification checklist

- `manifest.json` must not contain `content_security_policy` with `'unsafe-eval'` or `'unsafe-inline'`.
- New script sources must be added to `host_permissions`, not to a relaxed CSP.
- Any new dynamic rendering must not use `eval` or `innerHTML` with untrusted input.

---

## Principle of Least Privilege — Manifest Permissions

All declared permissions and their justification:

| Permission | Required for |
|-----------|-------------|
| `storage` | Persisting reviews (`chrome.storage.local`); session PR context (`chrome.storage.session`) |
| `activeTab` | Reading the active tab URL on explicit user action (the review button click) |
| `tabs` | Opening/updating tabs for file navigation from the side panel; querying tabs for sidepanel context lookup |
| `declarativeNetRequest` | Injecting `Accept` headers for GitHub diff API calls without exposing tokens to content scripts |
| `offscreen` | Creating an offscreen document to hold the long-lived WebSocket connection |
| `sidePanel` | Displaying the review panel via `chrome.sidePanel` |

### Review process

- Every permission addition requires a PR comment explaining why the new permission is necessary and why a narrower alternative was not sufficient.
- Prefer `activeTab` over broad `tabs` access where possible. The current `tabs` usage (sidepanel navigation, URL querying) is an accepted exception; revisit if Chrome adds a narrower API.
- No optional permissions (`chrome.permissions.request`) are currently used. If added, they must be requested at the point of use (not at install) and justified in code comments.
- Host permissions follow the same principle: new origins must be justified and scoped as narrowly as possible (path-level where the API supports it).

---

## Third-Party Dependency Trust Model

This extension vendors one third-party UI library:

**`src/vendor/preact-htm.js`** — bundled Preact + htm (hyperscript tagged markup). Loaded in the side panel for reactive rendering. No other external JavaScript is used.

### Vetting steps (required when updating the vendored file)

1. **Pinned version** — the file must be pinned to an exact upstream version. Record the version and upstream source URL in a comment at the top of the file.
2. **Checksum verification** — compare the SHA-256 of the local file against the published npm tarball checksum before committing.
3. **Changelog review** — read release notes for every version between current and new; flag any change to the rendering pipeline or `dangerouslySetInnerHTML` handling for additional security review.
4. **Source review** — for major version bumps, diff the minified bundle against the published release to confirm no unexpected additions.
5. **SCA scan** — run `npm audit` (or equivalent) against the upstream packages before bundling to catch known CVEs.

### Acceptable risk criteria and patching cadence

| Severity | Assessment deadline | Patch deadline |
|---------|-------------------|---------------|
| Critical / High | 3 days | 14 days |
| Medium | 14 days | 60 days |
| Low | 30 days | 90 days |

- No runtime fetching of third-party scripts; all external JS must be vendored and pass the vetting steps above.
- New major versions require a full security review (steps 1–5) before adoption, regardless of severity.
