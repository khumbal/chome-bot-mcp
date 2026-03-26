import type { Page } from "playwright";
import { browserManager } from "./browser.js";

const DEFAULT_SESSION = "default";
const ACTION_TIMEOUT_MS = 30_000;

interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: `ERROR: ${message}` }], isError: true };
}

async function ensurePage(sessionId: string = DEFAULT_SESSION): Promise<Page> {
  let session = browserManager.getSession(sessionId);
  if (!session) {
    const created = await browserManager.createSession(sessionId);
    return created.page;
  }
  return session.page;
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError") return `Timeout: ${err.message}`;
    return err.message;
  }
  return String(err);
}

// ─── Tool Implementations ────────────────────────────────────────────

export async function browserNavigate(args: { url: string; sessionId?: string }): Promise<ToolResult> {
  try {
    const url = new URL(args.url).href; // validate URL
    const page = await ensurePage(args.sessionId);
    const response = await page.goto(url, {
      waitUntil: "networkidle",
      timeout: ACTION_TIMEOUT_MS,
    });
    const status = response?.status() ?? "unknown";
    return ok(`Navigated to ${url} — HTTP ${status} — title: "${await page.title()}"`);
  } catch (err) {
    return fail(`browser_navigate: ${formatError(err)}`);
  }
}

export async function browserClick(args: { selector: string; sessionId?: string }): Promise<ToolResult> {
  try {
    const page = await ensurePage(args.sessionId);
    await page.waitForSelector(args.selector, { state: "visible", timeout: ACTION_TIMEOUT_MS });
    await page.click(args.selector, { timeout: ACTION_TIMEOUT_MS });
    return ok(`Clicked "${args.selector}"`);
  } catch (err) {
    return fail(`browser_click("${args.selector}"): ${formatError(err)}`);
  }
}

export async function browserFill(args: {
  selector: string;
  text: string;
  sessionId?: string;
}): Promise<ToolResult> {
  try {
    const page = await ensurePage(args.sessionId);
    await page.waitForSelector(args.selector, { state: "visible", timeout: ACTION_TIMEOUT_MS });
    await page.fill(args.selector, args.text, { timeout: ACTION_TIMEOUT_MS });
    return ok(`Filled "${args.selector}" with text (${args.text.length} chars)`);
  } catch (err) {
    return fail(`browser_fill("${args.selector}"): ${formatError(err)}`);
  }
}

export async function browserGetDomState(args: { sessionId?: string }): Promise<ToolResult> {
  try {
    const page = await ensurePage(args.sessionId);
    const [url, title, snapshot] = await Promise.all([
      page.url(),
      page.title(),
      page.locator("body").ariaSnapshot().catch(() => "unavailable"),
    ]);

    const state = {
      url,
      title,
      accessibilityTree: snapshot,
    };

    return ok(JSON.stringify(state, null, 2));
  } catch (err) {
    return fail(`browser_get_dom_state: ${formatError(err)}`);
  }
}

export async function browserCloseSession(args: { sessionId?: string }): Promise<ToolResult> {
  try {
    const id = args.sessionId ?? DEFAULT_SESSION;
    await browserManager.destroySession(id);
    return ok(`Session "${id}" closed`);
  } catch (err) {
    return fail(`browser_close_session: ${formatError(err)}`);
  }
}

export async function browserPressKey(args: {
  key: string;
  sessionId?: string;
}): Promise<ToolResult> {
  try {
    const page = await ensurePage(args.sessionId);
    await page.keyboard.press(args.key);
    // Wait for potential navigation after keypress
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
    return ok(`Pressed key "${args.key}" — current URL: ${page.url()}`);
  } catch (err) {
    return fail(`browser_press_key("${args.key}"): ${formatError(err)}`);
  }
}

export async function browserExtractText(args: {
  selector: string;
  sessionId?: string;
}): Promise<ToolResult> {
  try {
    const page = await ensurePage(args.sessionId);
    const locator = page.locator(args.selector).first();
    await locator.waitFor({ state: "attached", timeout: ACTION_TIMEOUT_MS });
    const text = await locator.textContent({ timeout: ACTION_TIMEOUT_MS });
    if (!text || text.trim().length === 0) {
      return ok(`Selector "${args.selector}" found but contains no text.`);
    }
    return ok(text.trim());
  } catch (err) {
    return fail(`browser_extract_text("${args.selector}"): ${formatError(err)}`);
  }
}

export async function browserScreenshot(args: {
  filename?: string;
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
    // Return as base64 so the orchestrator can inspect or save
    return {
      content: [
        { type: "text", text: `Screenshot captured (${buf.length} bytes, ${page.url()})` },
        { type: "image" as "text", text: `data:image/png;base64,${base64}` },
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
      await page.waitForSelector(args.selector, { state: "visible", timeout: ACTION_TIMEOUT_MS });
      return ok(`Element "${args.selector}" is now visible`);
    }
    const ms = Math.min(args.milliseconds ?? 2000, 30_000);
    await page.waitForTimeout(ms);
    return ok(`Waited ${ms}ms`);
  } catch (err) {
    return fail(`browser_wait: ${formatError(err)}`);
  }
}

// ─── Tool Schemas (MCP ListTools) ────────────────────────────────────

export const toolDefinitions = [
  {
    name: "browser_navigate",
    description:
      "Navigate the browser to a URL and wait for network idle. Returns HTTP status and page title.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "The URL to navigate to" },
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
    name: "browser_close_session",
    description:
      "Explicitly close a browser session and release its resources. Sessions also auto-expire after 120s.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID to close (default: 'default')" },
      },
      required: [],
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
        selector: { type: "string", description: "CSS selector to wait for (optional)" },
        milliseconds: { type: "number", description: "Fixed wait time in ms (max 30000, default 2000)" },
        sessionId: { type: "string", description: "Optional session ID" },
      },
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
    case "browser_get_dom_state":
      return browserGetDomState(args as { sessionId?: string });
    case "browser_close_session":
      return browserCloseSession(args as { sessionId?: string });
    case "browser_press_key":
      return browserPressKey(args as { key: string; sessionId?: string });
    case "browser_extract_text":
      return browserExtractText(args as { selector: string; sessionId?: string });
    case "browser_screenshot":
      return browserScreenshot(args as { filename?: string; fullPage?: boolean; sessionId?: string });
    case "browser_wait":
      return browserWait(args as { milliseconds?: number; selector?: string; sessionId?: string });
    default:
      return fail(`Unknown tool: ${name}`);
  }
}
