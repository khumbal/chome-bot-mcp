# chome-bot-mcp

MCP Server for browser automation — a component of the Vinyan Cognitive Operating System.

Uses Playwright with isolated browser contexts per session. Includes built-in tools for Google Search (AI Overview / AI Mode) and Google Gemini chat, with stealth patches to avoid bot detection.

## Setup

```bash
bun install
bunx playwright install chromium
```

## Run

```bash
bun run src/index.ts
```

By default the browser runs in **headful** mode (visible window) because Google blocks headless Chrome with CAPTCHAs. To force headless:

```bash
HEADLESS=true bun run src/index.ts
```

The server communicates over **stdio** (stdin/stdout) using the Model Context Protocol. Designed to be spawned as a child process by the Vinyan Orchestrator.

## MCP Tools

### Browser

| Tool | Arguments | Description |
|------|-----------|-------------|
| `browser_navigate` | `url`, `sessionId?` | Navigate to URL, wait for page load. Returns HTTP status and title. |
| `browser_click` | `selector`, `sessionId?` | Wait for element visibility, then click. |
| `browser_fill` | `selector`, `text`, `sessionId?` | Wait for input visibility, then fill with text. |
| `browser_press_key` | `key`, `sessionId?` | Press a keyboard key (e.g. `Enter`, `Tab`, `Escape`). |
| `browser_extract_text` | `selector`, `sessionId?` | Extract text content from the first matching CSS selector. |
| `browser_get_dom_state` | `sessionId?` | Return current URL, title, and accessibility tree snapshot. |
| `browser_screenshot` | `fullPage?`, `sessionId?` | Capture PNG screenshot, returned as base64. |
| `browser_wait` | `selector?`, `milliseconds?`, `sessionId?` | Wait for element visibility or a fixed delay (max 30s). |
| `browser_close_session` | `sessionId?` | Explicitly close a session and release resources. |
| `browser_list_sessions` | — | List all active session IDs and their metadata. |

### Google Search

| Tool | Arguments | Description |
|------|-----------|-------------|
| `google_search_ai_overview` | `query` | Search Google and extract the AI Overview summary. Falls back to top organic results if AI Overview is unavailable. Returns structured JSON. |
| `google_search_ai_mode` | `query` | Search Google via AI Mode (`udm=50`) for a direct AI-generated answer. Returns structured JSON. |

### Gemini

Gemini tools use a **persistent browser session** backed by a saved Chrome profile. On first use, run in headful mode and log in to your Google account manually. The session is reused on subsequent calls.

| Tool | Arguments | Description |
|------|-----------|-------------|
| `gemini_chat` | `message` | Send a message to Gemini and return its response. Maintains conversation context. |
| `gemini_new_chat` | — | Start a fresh Gemini conversation, clearing previous context. |
| `gemini_summarize_youtube` | `youtubeUrl` | Ask Gemini to summarize a YouTube video. Returns JSON with `youtubeUrl` and `summary`. |

## Session Management

Every browser tool accepts an optional `sessionId`. Each session maps to an isolated Playwright `BrowserContext` — no cookies, localStorage, or state is shared between sessions. Ephemeral sessions auto-expire after 120 seconds of inactivity (configurable via `SESSION_TTL_MS`).

Gemini uses a single shared persistent session serialized with a mutex to prevent concurrent access.

## Chrome Profile

Chrome profile is persisted to `~/.chome-bot-mcp/chrome-profile` by default. This allows Google login state (for Gemini) to survive restarts. Override with `CHROME_PROFILE_DIR`.

## Anti-Detection

The browser launches with stealth patches:
- Hides `navigator.webdriver`
- Injects Chrome runtime stubs (`window.chrome`)
- Sets realistic `navigator.plugins` and `navigator.languages`
- Disables `AutomationControlled` Blink feature flag

This is required for Google and similar sites that aggressively detect headless/automated browsers.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HEADLESS` | `false` | Set to `true` to run browser in headless mode. |
| `SESSION_TTL_MS` | `120000` | Ephemeral session idle timeout in milliseconds. |
| `MAX_SESSIONS` | `10` | Maximum number of concurrent browser sessions. |
| `CHROME_PROFILE_DIR` | `~/.chome-bot-mcp/chrome-profile` | Path to persistent Chrome profile directory. |
| `GEMINI_TIMEOUT_MS` | `90000` | Timeout for waiting on Gemini responses in milliseconds. |

## MCP Client Config

Add to your MCP client configuration (e.g. Claude Desktop, VS Code):

```json
{
  "mcpServers": {
    "chome-bot-mcp": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/chome-bot-mcp/src/index.ts"]
    }
  }
}
```
