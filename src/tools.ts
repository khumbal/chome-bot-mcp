import type { Page } from "playwright";
import { browserManager } from "./browser.js";
import {
  type ToolResult,
  ok,
  fail,
  formatError,
  validateNonEmpty,
  validateUrl,
  ValidationError,
  log,
} from "./shared.js";

const DEFAULT_SESSION = "default";
const ACTION_TIMEOUT_MS = 30_000;

// ─── Page Resolution ─────────────────────────────────────────────────

async function ensurePage(sessionId: string = DEFAULT_SESSION): Promise<Page> {
  // Try existing session first (with health check)
  const page = browserManager.getActivePage(sessionId);
  if (page) return page;

  // Auto-create ephemeral session
  log.debug("Auto-creating session", { sessionId });
  const created = await browserManager.createSession(sessionId);
  return created.page;
}

// ─── Tool Implementations ────────────────────────────────────────────

export async function browserNavigate(args: { url: string; sessionId?: string }): Promise<ToolResult> {
  try {
    const parsed = validateUrl(args.url, "url");
    const page = await ensurePage(args.sessionId);
    const response = await page.goto(parsed.href, {
      waitUntil: "domcontentloaded",
      timeout: ACTION_TIMEOUT_MS,
    });
    // Wait for network to settle, but don't block forever on streaming pages
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    const status = response?.status() ?? "unknown";
    const title = await page.title().catch(() => "(untitled)");
    return ok(`Navigated to ${parsed.href} — HTTP ${status} — title: "${title}"`);
  } catch (err) {
    if (err instanceof ValidationError) return fail(err.message);
    return fail(`browser_navigate: ${formatError(err)}`);
  }
}

export async function browserClick(args: { selector: string; sessionId?: string }): Promise<ToolResult> {
  try {
    const selector = validateNonEmpty(args.selector, "selector");
    const page = await ensurePage(args.sessionId);
    await page.waitForSelector(selector, { state: "visible", timeout: ACTION_TIMEOUT_MS });
    await page.click(selector, { timeout: ACTION_TIMEOUT_MS });
    return ok(`Clicked "${selector}"`);
  } catch (err) {
    if (err instanceof ValidationError) return fail(err.message);
    return fail(`browser_click("${args.selector}"): ${formatError(err)}`);
  }
}

export async function browserFill(args: {
  selector: string;
  text: string;
  sessionId?: string;
}): Promise<ToolResult> {
  try {
    const selector = validateNonEmpty(args.selector, "selector");
    if (typeof args.text !== "string") {
      return fail('"text" is required and must be a string.');
    }
    const page = await ensurePage(args.sessionId);
    await page.waitForSelector(selector, { state: "visible", timeout: ACTION_TIMEOUT_MS });
    await page.fill(selector, args.text, { timeout: ACTION_TIMEOUT_MS });
    return ok(`Filled "${selector}" with text (${args.text.length} chars)`);
  } catch (err) {
    if (err instanceof ValidationError) return fail(err.message);
    return fail(`browser_fill("${args.selector}"): ${formatError(err)}`);
  }
}

export async function browserGetDomState(args: { sessionId?: string }): Promise<ToolResult> {
  try {
    const page = await ensurePage(args.sessionId);
    const [url, title, snapshot] = await Promise.all([
      page.url(),
      page.title().catch(() => "(untitled)"),
      page.locator("body").ariaSnapshot().catch(() => "unavailable"),
    ]);

    return ok(JSON.stringify({ url, title, accessibilityTree: snapshot }, null, 2));
  } catch (err) {
    return fail(`browser_get_dom_state: ${formatError(err)}`);
  }
}

export async function browserCloseSession(args: { sessionId?: string }): Promise<ToolResult> {
  try {
    const id = args.sessionId ?? DEFAULT_SESSION;
    await browserManager.destroySession(id);
    return ok(`Session "${id}" closed.`);
  } catch (err) {
    return fail(`browser_close_session: ${formatError(err)}`);
  }
}

export async function browserPressKey(args: {
  key: string;
  sessionId?: string;
}): Promise<ToolResult> {
  try {
    const key = validateNonEmpty(args.key, "key");
    const page = await ensurePage(args.sessionId);
    await page.keyboard.press(key);
    // Wait for potential navigation after keypress
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
    return ok(`Pressed key "${key}" — current URL: ${page.url()}`);
  } catch (err) {
    if (err instanceof ValidationError) return fail(err.message);
    return fail(`browser_press_key("${args.key}"): ${formatError(err)}`);
  }
}

export async function browserExtractText(args: {
  selector: string;
  sessionId?: string;
}): Promise<ToolResult> {
  try {
    const selector = validateNonEmpty(args.selector, "selector");
    const page = await ensurePage(args.sessionId);
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: "attached", timeout: ACTION_TIMEOUT_MS });
    const text = await locator.textContent({ timeout: ACTION_TIMEOUT_MS });
    if (!text || text.trim().length === 0) {
      return ok(`Selector "${selector}" found but contains no text.`);
    }
    return ok(text.trim());
  } catch (err) {
    if (err instanceof ValidationError) return fail(err.message);
    return fail(`browser_extract_text("${args.selector}"): ${formatError(err)}`);
  }
}

export async function browserScreenshot(args: {
  fullPage?: boolean;
  sessionId?: string;
}): Promise<ToolResult> {
  try {
    const page = await ensurePage(args.sessionId);
    const buf = await page.screenshot({
      fullPage: args.fullPage ?? false,
      type: "png",
    });
    const base64 = Buffer.from(buf).toString("base64");
    return {
      content: [
        { type: "text", text: `Screenshot captured (${buf.length} bytes, ${page.url()})\n\ndata:image/png;base64,${base64}` },
      ],
    };
  } catch (err) {
    return fail(`browser_screenshot: ${formatError(err)}`);
  }
}

export async function browserWait(args: {
  milliseconds?: number;
  selector?: string;
  sessionId?: string;
}): Promise<ToolResult> {
  try {
    const page = await ensurePage(args.sessionId);

    if (args.selector) {
      const selector = validateNonEmpty(args.selector, "selector");
      await page.waitForSelector(selector, { state: "visible", timeout: ACTION_TIMEOUT_MS });
      return ok(`Element "${selector}" is now visible.`);
    }

    const ms = Math.max(0, Math.min(args.milliseconds ?? 2000, 30_000));
    await page.waitForTimeout(ms);
    return ok(`Waited ${ms}ms.`);
  } catch (err) {
    if (err instanceof ValidationError) return fail(err.message);
    return fail(`browser_wait: ${formatError(err)}`);
  }
}

export async function browserListSessions(): Promise<ToolResult> {
  const sessions = browserManager.listSessions();
  if (sessions.length === 0) return ok("No active sessions.");
  return ok(JSON.stringify(sessions, null, 2));
}

// ─── Tool Schemas (MCP ListTools) ────────────────────────────────────

export const toolDefinitions = [
  {
    name: "browser_navigate",
    description:
      "Navigate the browser to a URL and wait for the page to load. Returns HTTP status and page title.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "The URL to navigate to (http/https only)" },
        sessionId: {
          type: "string",
          description: "Optional session ID for isolated browser contexts (default: 'default')",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_click",
    description:
      "Wait for an element matching the CSS selector to become visible, then click it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        selector: { type: "string", description: "CSS selector of the element to click" },
        sessionId: { type: "string", description: "Optional session ID" },
      },
      required: ["selector"],
    },
  },
  {
    name: "browser_fill",
    description:
      "Wait for an input element matching the CSS selector to become visible, then fill it with text.",
    inputSchema: {
      type: "object" as const,
      properties: {
        selector: { type: "string", description: "CSS selector of the input element" },
        text: { type: "string", description: "Text to fill into the input" },
        sessionId: { type: "string", description: "Optional session ID" },
      },
      required: ["selector", "text"],
    },
  },
  {
    name: "browser_press_key",
    description:
      "Press a keyboard key (e.g. 'Enter', 'Tab', 'Escape', 'ArrowDown'). Useful for submitting forms or triggering actions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: { type: "string", description: "Key to press (e.g. 'Enter', 'Tab', 'Escape')" },
        sessionId: { type: "string", description: "Optional session ID" },
      },
      required: ["key"],
    },
  },
  {
    name: "browser_extract_text",
    description:
      "Extract the text content of the first element matching a CSS selector. Use this to read specific parts of a page.",
    inputSchema: {
      type: "object" as const,
      properties: {
        selector: { type: "string", description: "CSS selector to extract text from" },
        sessionId: { type: "string", description: "Optional session ID" },
      },
      required: ["selector"],
    },
  },
  {
    name: "browser_get_dom_state",
    description:
      "Return the current page URL, title, and a simplified accessibility tree snapshot for the Orchestrator's StateVector.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Optional session ID" },
      },
      required: [],
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Capture a PNG screenshot of the current page. Returns base64-encoded image data.",
    inputSchema: {
      type: "object" as const,
      properties: {
        fullPage: { type: "boolean", description: "Capture full page (default: false, viewport only)" },
        sessionId: { type: "string", description: "Optional session ID" },
      },
      required: [],
    },
  },
  {
    name: "browser_wait",
    description:
      "Wait for a CSS selector to become visible, or wait for a fixed number of milliseconds. Useful for pages with dynamic content.",
    inputSchema: {
      type: "object" as const,
      properties: {
        selector: { type: "string", description: "CSS selector to wait for (priority over milliseconds)" },
        milliseconds: { type: "number", description: "Fixed wait time in ms (max 30000, default 2000)" },
        sessionId: { type: "string", description: "Optional session ID" },
      },
      required: [],
    },
  },
  {
    name: "browser_close_session",
    description:
      "Explicitly close a browser session and release its resources. Ephemeral sessions also auto-expire after 120s of inactivity.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID to close (default: 'default')" },
      },
      required: [],
    },
  },
  {
    name: "browser_list_sessions",
    description:
      "List all active browser sessions with their IDs, types, ages, and current URLs. Useful for debugging.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
] as const;

// ─── Tool Dispatcher ─────────────────────────────────────────────────

export async function dispatchTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case "browser_navigate":
      return browserNavigate(args as { url: string; sessionId?: string });
    case "browser_click":
      return browserClick(args as { selector: string; sessionId?: string });
    case "browser_fill":
      return browserFill(args as { selector: string; text: string; sessionId?: string });
    case "browser_press_key":
      return browserPressKey(args as { key: string; sessionId?: string });
    case "browser_extract_text":
      return browserExtractText(args as { selector: string; sessionId?: string });
    case "browser_get_dom_state":
      return browserGetDomState(args as { sessionId?: string });
    case "browser_screenshot":
      return browserScreenshot(args as { fullPage?: boolean; sessionId?: string });
    case "browser_wait":
      return browserWait(args as { milliseconds?: number; selector?: string; sessionId?: string });
    case "browser_close_session":
      return browserCloseSession(args as { sessionId?: string });
    case "browser_list_sessions":
      return browserListSessions();
    default:
      return fail(`Unknown tool: "${name}". Use browser_list_sessions to see available tools.`);
  }
}
