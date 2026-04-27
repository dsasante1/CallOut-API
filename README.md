# API Endpoint Overlay

A Chrome extension that intercepts and displays all API calls made by a web page — overlaid directly on the site in a floating panel. Instantly see which network requests are happening, what triggered them, and inspect request/response payloads without opening DevTools.

## Features

- **Live request capture** — intercepts `fetch`, `XMLHttpRequest`, and `WebSocket` traffic in real time
- **Trigger element linking** — identifies which DOM element the user interacted with that caused each request, with hover-to-highlight on page
- **Floating overlay panel** — draggable, dark-themed panel rendered on top of any site; no DevTools required
- **Request/response body preview** — click any row to expand and see payload; JSON is auto-pretty-printed
- **WebSocket support** — tracks connection lifecycle and shows a scrollable sent/received message thread
- **URL filtering and method filtering** — filter the list by URL substring or HTTP method (GET, POST, PUT, DELETE, PATCH, WS)
- **Domain grouping** — toggle to group requests by hostname, with first-party vs third-party distinction
- **HAR export** — export all captured HTTP requests as a standard `.har` file compatible with browser DevTools and analysis tools
- **Pause / Resume** — freeze capture while keeping the current list visible
- **Float badges** — short-lived method+path badges that appear near the trigger element on the page

## Project Structure

```
api-overlay-extension/
├── src/
│   ├── content.ts      # Content script: builds overlay panel, renders UI, handles messages
│   ├── injected.ts     # Page-world script: monkey-patches fetch/XHR/WebSocket, emits events
│   ├── popup.ts        # Extension popup: toggle, pause, export, clear controls
│   └── utils.ts        # Shared pure utilities (escHtml, formatBody, getHostname, extractBody)
├── tests/
│   └── utils.test.ts   # Unit tests for utils
├── dist/               # Compiled JS output (gitignored)
├── popup.html          # Popup markup
├── manifest.json       # Extension manifest (Manifest V3)
├── tsconfig.json       # TypeScript config
├── tsconfig.test.json  # TypeScript config for tests
├── vitest.config.ts    # Vitest config
└── package.json
```

## How It Works

The extension uses a two-script architecture required by Manifest V3's content security model:

1. **`injected.ts`** runs in the **page world** (same JS context as the site). It monkey-patches `window.fetch`, `XMLHttpRequest.prototype.open/send`, and `window.WebSocket` to intercept all outgoing network requests. When a request starts or completes, it posts a message to `window` with full metadata.

2. **`content.ts`** runs in the **content script world** (isolated from the page). It listens for those `window.postMessage` events and builds the overlay panel into the page DOM. It also tracks interaction state (hover → highlight, expand/collapse rows) and responds to commands from the popup.

3. **`popup.ts`** controls the extension popup, which sends `chrome.tabs.sendMessage` commands (`toggle`, `pause`, `clear`, `export-har`) to the content script.

```
Page JS ──postMessage──▶ content.ts ──renders──▶ overlay panel
                                  ◀──sendMessage── popup.ts
```

## Installation

### From source

1. Clone the repository:
   ```bash
   git clone <repo-url>
   cd api-overlay-extension
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build:
   ```bash
   npm run build
   ```

4. Load in Chrome:
   - Open `chrome://extensions`
   - Enable **Developer mode** (top-right toggle)
   - Click **Load unpacked**
   - Select the `api-overlay-extension/` directory

The extension is now active on all sites.

## Development

| Command | Description |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run watch` | Watch mode — recompiles on file change |
| `npm test` | Run unit tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with coverage report |

After each `build`, reload the extension in `chrome://extensions` (click the refresh icon on the extension card) and reload the target tab.

## Usage

Once installed, visit any website. The overlay panel appears in the bottom-right corner automatically.

| Action | How |
|---|---|
| Expand a request | Click any row |
| Highlight the trigger element | Hover a row |
| Filter by URL | Type in the filter box |
| Filter by method | Use the method dropdown |
| Group by domain | Click **Group** button |
| Copy a URL | Click the **copy** button on a row |
| Pause/resume capture | Click **Pause** / **Resume** in the panel or popup |
| Clear all requests | Click **Clear** in the panel or popup |
| Export as HAR | Click **Export HAR** in the panel or popup |
| Hide/show panel | Click **Hide Panel** / **Show Panel** in the popup |
| Move the panel | Drag the header bar |

## HAR Export

The **Export HAR** action generates a [HTTP Archive (HAR 1.2)](https://w3c.github.io/web-performance/specs/HAR/Overview.html) file containing all captured HTTP requests (WebSocket connections are excluded). The file can be imported into:

- Chrome DevTools → Network tab → Import HAR
- Firefox DevTools
- [HAR Analyzer](https://toolbox.googleapps.com/apps/har_analyzer/) by Google
- Postman, Charles Proxy, and other HTTP inspection tools

## Permissions

| Permission | Purpose |
|---|---|
| `tabs` | Read the active tab ID to send messages from the popup |
| `activeTab` | Scope message sending to the current tab |
| `scripting` | Inject the page-world script (`injected.js`) |
| `host_permissions: <all_urls>` | Allow content scripts and `web_accessible_resources` on all sites |

## Technical Notes

- The injected script is guarded by `window.__apiOverlayActive` to prevent double-injection on navigation.
- Trigger element detection uses a 800 ms window from the last `mousedown`/`touchstart`/`keydown` event. Requests made outside that window are attributed to "background / auto".
- CSS is injected with `!important` on every rule to avoid style bleed from the host page overriding the panel.
- Request/response bodies are capped at 50 000 characters; WebSocket messages at 10 000 characters.
- The panel renders at most 200 requests at a time (newest first) to keep the DOM lightweight.
- The overlay uses `z-index: 2147483647` (the maximum 32-bit integer) to stay on top of all page content.

## Tech Stack

- TypeScript 5 (strict mode)
- Manifest V3 Chrome Extension APIs
- Vitest for unit testing
- No runtime dependencies
