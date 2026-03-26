# vinyan-chrome-mcp

Stateless MCP Server for browser automation — a component of the Vinyan Cognitive Operating System.

Uses Playwright with isolated browser contexts per session for zero state contamination.

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

The server communicates over **stdio** (stdin/stdout) using the Model Context Protocol. It is designed to be spawned as a child process by the Vinyan Orchestrator.

## MCP Tools

| Tool | Arguments | Description |
|------|-----------|-------------|
| `browser_navigate` | `url`, `sessionId?` | Navigate to URL, wait for network idle |
| `browser_click` | `selector`, `sessionId?` | Wait for element visibility, then click |
| `browser_fill` | `selector`, `text`, `sessionId?` | Wait for input visibility, then fill |
| `browser_press_key` | `key`, `sessionId?` | Press a keyboard key (Enter, Tab, etc.) |
| `browser_extract_text` | `selector`, `sessionId?` | Extract text content from a CSS selector |
| `browser_get_dom_state` | `sessionId?` | Return current URL, title, and accessibility tree |
| `browser_screenshot` | `fullPage?`, `sessionId?` | Capture PNG screenshot (base64) |
| `browser_wait` | `selector?`, `milliseconds?`, `sessionId?` | Wait for element or fixed delay |
| `browser_close_session` | `sessionId?` | Close session and release resources |

### Session Management

Every tool accepts an optional `sessionId` parameter. Each session maps to an isolated Playwright `BrowserContext` — no cookies, localStorage, or state is shared between sessions. Sessions auto-expire after 120 seconds.

### Anti-Detection

The browser launches with stealth patches (hides `navigator.webdriver`, injects Chrome runtime stubs) and uses the real Chrome channel instead of Playwright's headless shell. This is required for Google and similar sites that aggressively detect automation.

## MCP Client Config

Add to your MCP client configuration (e.g. Claude Desktop, VS Code):

```json
{
  "mcpServers": {
    "vinyan-chrome-mcp": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/vinyan-chrome-mcp/src/index.ts"]
    }
  }
}
```
