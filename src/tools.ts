import type { Page } from "playwright";
import { browserManager } from "./browser.js";
import { extractLinks } from "./content.js";
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

export async function browserGetDomState(args: {
  sessionId?: string;
  selector?: string;
  mode?: "full" | "interactive" | "headings";
  maxLength?: number;
}): Promise<ToolResult> {
  try {
    const page = await ensurePage(args.sessionId);
    const selector = args.selector ?? "body";
    const mode = args.mode ?? "full";
    const maxLength = args.maxLength ?? 8000;

    const [url, title] = await Promise.all([
      page.url(),
      page.title().catch(() => "(untitled)"),
    ]);

    let content: string;

    switch (mode) {
      case "interactive": {
        content = await page.evaluate((sel: string) => {
          const root = document.querySelector(sel);
          if (!root) return "(selector not found)";
          const lines: string[] = [];
          for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
            const text = a.textContent?.trim();
            if (text) lines.push(`[link] ${text} → ${a.href}`);
          }
          for (const btn of Array.from(root.querySelectorAll<HTMLButtonElement>("button"))) {
            const text = btn.textContent?.trim();
            if (text) lines.push(`[button] ${text}`);
          }
          for (const input of Array.from(root.querySelectorAll<HTMLInputElement>("input"))) {
            const name = input.name || input.id || "";
            lines.push(`[input] type=${input.type} name=${name} placeholder=${input.placeholder || ""}`);
          }
          for (const sel of Array.from(root.querySelectorAll<HTMLSelectElement>("select"))) {
            const name = sel.name || sel.id || "";
            const opts = Array.from(sel.options).map((o) => o.text).slice(0, 5).join(", ");
            lines.push(`[select] name=${name} options=[${opts}]`);
          }
          return lines.join("\n");
        }, selector);
        break;
      }
      case "headings": {
        content = await page.evaluate((sel: string) => {
          const root = document.querySelector(sel);
          if (!root) return "(selector not found)";
          const lines: string[] = [];
          for (const h of Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6"))) {
            const level = h.tagName.toLowerCase();
            const text = h.textContent?.trim();
            if (text) lines.push(`[${level}] ${text}`);
          }
          lines.push("");
          for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
            const text = a.textContent?.trim();
            if (text) lines.push(`[link] ${text} → ${a.href}`);
          }
          for (const btn of Array.from(root.querySelectorAll<HTMLButtonElement>("button"))) {
            const text = btn.textContent?.trim();
            if (text) lines.push(`[button] ${text}`);
          }
          for (const input of Array.from(root.querySelectorAll<HTMLInputElement>("input"))) {
            const name = input.name || input.id || "";
            lines.push(`[input] type=${input.type} name=${name} placeholder=${input.placeholder || ""}`);
          }
          for (const sel of Array.from(root.querySelectorAll<HTMLSelectElement>("select"))) {
            const name = sel.name || sel.id || "";
            const opts = Array.from(sel.options).map((o) => o.text).slice(0, 5).join(", ");
            lines.push(`[select] name=${name} options=[${opts}]`);
          }
          return lines.join("\n");
        }, selector);
        break;
      }
      default: {
        // "full" — complete accessibility tree
        content = await page.locator(selector).ariaSnapshot().catch(() => "unavailable");
        break;
      }
    }

    // Truncate to maxLength
    if (content.length > maxLength) {
      content = content.slice(0, maxLength) + `\n...[truncated at ${maxLength} chars]`;
    }

    return ok(JSON.stringify({ url, title, mode, content }, null, 2));
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
  describe?: boolean;
  sessionId?: string;
}): Promise<ToolResult> {
  try {
    const page = await ensurePage(args.sessionId);

    if (args.describe) {
      // Return text description of page layout instead of image
      const description = await page.evaluate(() => {
        const title = document.title || "(untitled)";

        const headings: string[] = [];
        for (const h of Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"))) {
          const text = h.textContent?.trim();
          if (text) headings.push(`[${h.tagName.toLowerCase()}] ${text}`);
        }

        const forms: string[] = [];
        for (const form of Array.from(document.querySelectorAll("form"))) {
          const inputs = Array.from(form.querySelectorAll<HTMLInputElement>("input, textarea, select"))
            .map((i) => `${i.tagName.toLowerCase()}[${i.type || "text"}] name=${i.name || i.id || "?"}${i.placeholder ? ` placeholder="${i.placeholder}"` : ""}`)
            .slice(0, 10);
          const submit = form.querySelector<HTMLButtonElement>("button[type=submit], input[type=submit]");
          forms.push(`form: ${inputs.join(", ")}${submit ? ` → submit: "${submit.textContent?.trim() || "Submit"}"` : ""}`);
        }

        const buttons: string[] = [];
        for (const btn of Array.from(document.querySelectorAll("button"))) {
          const text = btn.textContent?.trim();
          if (text && !btn.closest("form")) buttons.push(text);
        }

        const images: string[] = [];
        for (const img of Array.from(document.querySelectorAll<HTMLImageElement>("img[alt]"))) {
          const alt = img.alt?.trim();
          if (alt && alt.length > 2) images.push(alt);
        }

        // Content preview: first 500 chars of main content area
        const main = document.querySelector("main, article, [role=main]") || document.body;
        const contentPreview = (main.textContent || "").trim().replace(/\s+/g, " ").slice(0, 500);

        return { title, headings, forms, buttons: buttons.slice(0, 20), images: images.slice(0, 10), contentPreview };
      });

      return ok(JSON.stringify({
        url: page.url(),
        ...description,
      }, null, 2));
    }

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

export async function browserListLinks(args: {
  selector?: string;
  filter?: "internal" | "external" | "all";
  maxResults?: number;
  sessionId?: string;
}): Promise<ToolResult> {
  try {
    const page = await ensurePage(args.sessionId);
    const links = await extractLinks(page, {
      selector: args.selector,
      filter: args.filter,
      maxResults: args.maxResults,
    });
    return ok(JSON.stringify({ count: links.length, links }, null, 2));
  } catch (err) {
    return fail(`browser_list_links: ${formatError(err)}`);
  }
}

export async function browserExtractStructured(args: {
  selector: string;
  fields: Record<string, string>;
  maxResults?: number;
  sessionId?: string;
}): Promise<ToolResult> {
  try {
    const selector = validateNonEmpty(args.selector, "selector");
    if (!args.fields || typeof args.fields !== "object" || Object.keys(args.fields).length === 0) {
      return fail('"fields" is required and must be a non-empty object mapping field names to CSS selectors.');
    }
    const maxResults = Math.max(1, Math.min(args.maxResults ?? 100, 500));
    const page = await ensurePage(args.sessionId);

    const data = await page.evaluate(
      ({ selector, fields, maxResults }: { selector: string; fields: Record<string, string>; maxResults: number }) => {
        const rows = Array.from(document.querySelectorAll(selector)).slice(0, maxResults);
        return rows.map((row) => {
          const obj: Record<string, string> = {};
          for (const [name, sel] of Object.entries(fields)) {
            const el = row.querySelector(sel);
            obj[name] = el?.textContent?.trim() ?? "";
          }
          return obj;
        });
      },
      { selector, fields: args.fields, maxResults },
    );

    return ok(JSON.stringify({ count: data.length, data }, null, 2));
  } catch (err) {
    if (err instanceof ValidationError) return fail(err.message);
    return fail(`browser_extract_structured: ${formatError(err)}`);
  }
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
      "Return the current page URL, title, and content based on the selected mode. Use 'interactive' mode (default) for a compact list of actionable elements (links, buttons, inputs). Use 'headings' mode for page structure overview. Use 'full' mode for the complete accessibility tree.",
    inputSchema: {
      type: "object" as const,
      properties: {
        selector: {
          type: "string",
          description: "CSS selector to scope the snapshot (default: 'body'). Use to inspect a specific section.",
        },
        mode: {
          type: "string",
          enum: ["full", "interactive", "headings"],
          description: "Snapshot mode: 'interactive' (links, buttons, inputs — compact), 'headings' (page structure + interactive), 'full' (complete accessibility tree). Default: 'interactive'.",
        },
        maxLength: {
          type: "number",
          description: "Maximum character length of the content output (default: 8000). Helps manage context window usage.",
        },
        sessionId: { type: "string", description: "Optional session ID" },
      },
      required: [],
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Capture a PNG screenshot of the current page, or describe the page layout as text. Use 'describe: true' for a token-efficient text summary of the page structure (headings, forms, buttons, images, content preview) without image data.",
    inputSchema: {
      type: "object" as const,
      properties: {
        fullPage: { type: "boolean", description: "Capture full page (default: false, viewport only)" },
        describe: {
          type: "boolean",
          description: "Return a text description of the page layout instead of a screenshot image. Includes headings, forms, buttons, images, and content preview. Default: false.",
        },
        sessionId: { type: "string", description: "Optional session ID" },
      },
      required: [],
    },
  },
  {
    name: "browser_extract_structured",
    description:
      "Extract structured data from repeating elements on the page (tables, lists, product grids). Provide a CSS selector for row elements and a field-to-selector mapping. Returns an array of objects.",
    inputSchema: {
      type: "object" as const,
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for the repeating row/item elements (e.g. 'table tbody tr', '.product-card')",
        },
        fields: {
          type: "object",
          description:
            "Map field names to CSS selectors relative to each row element. Example: { \"name\": \"td:nth-child(1)\", \"price\": \"td:nth-child(2)\" }",
          additionalProperties: { type: "string" },
        },
        maxResults: {
          type: "number",
          description: "Maximum number of rows to extract (default: 100, max: 500)",
        },
        sessionId: { type: "string", description: "Optional session ID" },
      },
      required: ["selector", "fields"],
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
  {
    name: "browser_list_links",
    description:
      "Extract all links from the current page. Returns an array of { text, href, isInternal } objects. Useful for discovering navigation targets without parsing the full DOM.",
    inputSchema: {
      type: "object" as const,
      properties: {
        selector: {
          type: "string",
          description: "CSS selector to scope link extraction (default: 'body')",
        },
        filter: {
          type: "string",
          enum: ["internal", "external", "all"],
          description: "Filter links: 'internal' (same domain), 'external' (different domain), 'all' (default)",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of links to return (default: 50)",
        },
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
    case "browser_press_key":
      return browserPressKey(args as { key: string; sessionId?: string });
    case "browser_extract_text":
      return browserExtractText(args as { selector: string; sessionId?: string });
    case "browser_get_dom_state":
      return browserGetDomState(args as { sessionId?: string; selector?: string; mode?: "full" | "interactive" | "headings"; maxLength?: number });
    case "browser_screenshot":
      return browserScreenshot(args as { fullPage?: boolean; describe?: boolean; sessionId?: string });
    case "browser_extract_structured":
      return browserExtractStructured(args as { selector: string; fields: Record<string, string>; maxResults?: number; sessionId?: string });
    case "browser_wait":
      return browserWait(args as { milliseconds?: number; selector?: string; sessionId?: string });
    case "browser_close_session":
      return browserCloseSession(args as { sessionId?: string });
    case "browser_list_sessions":
      return browserListSessions();
    case "browser_list_links":
      return browserListLinks(args as { selector?: string; filter?: "internal" | "external" | "all"; maxResults?: number; sessionId?: string });
    default:
      return fail(`Unknown tool: "${name}". Use browser_list_sessions to see available tools.`);
  }
}
