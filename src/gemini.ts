import type { Page } from "playwright";
import { browserManager } from "./browser.js";

const GEMINI_SESSION = "gemini";
const GEMINI_URL = "https://gemini.google.com/app";
const RESPONSE_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_500;

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

function formatError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError") return `Timeout: ${err.message}`;
    return err.message;
  }
  return String(err);
}

// ─── Internal Helpers ────────────────────────────────────────────────

async function ensureGeminiPage(): Promise<Page> {
  let session = browserManager.getSession(GEMINI_SESSION);

  if (!session) {
    // Use persistent session to keep Google login alive
    const created = await browserManager.createPersistentSession(GEMINI_SESSION);
    session = browserManager.getSession(GEMINI_SESSION)!;

    // Navigate to Gemini if not already there
    if (!created.page.url().includes("gemini.google.com")) {
      await created.page.goto(GEMINI_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await created.page.waitForTimeout(2_000);
    }
  }

  return session!.page;
}

function isLoginPage(page: Page): boolean {
  const url = page.url();
  return url.includes("accounts.google.com") || url.includes("/signin");
}

/**
 * Wait for Gemini to finish generating its response.
 * Detects completion by watching for the response to stop changing.
 */
async function waitForGeminiResponse(page: Page): Promise<string> {
  const startTime = Date.now();
  let lastText = "";
  let stableCount = 0;

  while (Date.now() - startTime < RESPONSE_TIMEOUT_MS) {
    await page.waitForTimeout(POLL_INTERVAL_MS);

    // Try multiple selectors for Gemini's response container
    const responseText = await extractLatestResponse(page);

    if (responseText && responseText === lastText) {
      stableCount++;
      // Response is stable for 3 consecutive polls → done
      if (stableCount >= 3) {
        return responseText;
      }
    } else {
      stableCount = 0;
      lastText = responseText ?? "";
    }
  }

  // Timeout — return whatever we have
  return lastText || "Gemini response timed out (no content received).";
}

async function extractLatestResponse(page: Page): Promise<string | null> {
  // Gemini response selectors (the last message-content element is the latest response)
  const selectors = [
    "message-content.model-response-text",  // Gemini's response content
    ".model-response-text",                  // alt
    ".response-container-content",           // alt
    ".markdown-main-panel",                  // markdown rendered response
    "[data-content-type='response']",        // data attribute
  ];

  for (const sel of selectors) {
    const elements = page.locator(sel);
    const count = await elements.count().catch(() => 0);
    if (count > 0) {
      // Get the last response element (most recent)
      const text = await elements.last().textContent({ timeout: 3_000 }).catch(() => null);
      if (text && text.trim().length > 0) {
        return text.trim();
      }
    }
  }

  // Broad fallback: get all turn containers and pick the last one
  const turns = page.locator(".conversation-turn, .turn-content");
  const turnCount = await turns.count().catch(() => 0);
  if (turnCount > 0) {
    const lastTurn = await turns.last().textContent({ timeout: 3_000 }).catch(() => null);
    if (lastTurn && lastTurn.trim().length > 0) {
      return lastTurn.trim();
    }
  }

  return null;
}

async function sendMessageToGemini(page: Page, message: string): Promise<void> {
  // Gemini input selectors
  const inputSelectors = [
    'div[contenteditable="true"]',           // contenteditable rich editor
    '.ql-editor[contenteditable="true"]',    // quill editor
    'textarea',                               // fallback textarea
    '.text-input-field',                      // generic input
  ];

  let inputFound = false;
  for (const sel of inputSelectors) {
    const input = page.locator(sel).first();
    const visible = await input.isVisible({ timeout: 3_000 }).catch(() => false);
    if (visible) {
      await input.click();
      await input.fill(message);
      inputFound = true;
      break;
    }
  }

  if (!inputFound) {
    throw new Error("Cannot find Gemini input field. The UI may have changed or login is required.");
  }

  // Click send button or press Enter
  const sendButton = page.locator(
    'button[aria-label="Send message"], button[aria-label="ส่งข้อความ"], button.send-button, button[mattooltip="Send"]'
  ).first();
  const hasSendButton = await sendButton.isVisible({ timeout: 2_000 }).catch(() => false);

  if (hasSendButton) {
    await sendButton.click();
  } else {
    await page.keyboard.press("Enter");
  }
}

// ─── Tool Implementations ────────────────────────────────────────────

/**
 * gemini_chat: Send a message to Gemini and return its response.
 * Maintains conversation context within the same session.
 */
export async function geminiChat(args: { message: string }): Promise<ToolResult> {
  try {
    const page = await ensureGeminiPage();

    if (isLoginPage(page)) {
      return fail(
        "Google login required. Please run the server in headful mode (HEADLESS=false), " +
        "then use browser_navigate to go to https://gemini.google.com and log in manually. " +
        "Your login will be persisted in ~/.vinyan-chrome-mcp/chrome-profile/"
      );
    }

    await sendMessageToGemini(page, args.message);
    const response = await waitForGeminiResponse(page);

    return ok(response);
  } catch (err) {
    return fail(`gemini_chat: ${formatError(err)}`);
  }
}

/**
 * gemini_new_chat: Start a fresh Gemini conversation (clears context).
 */
export async function geminiNewChat(): Promise<ToolResult> {
  try {
    const page = await ensureGeminiPage();

    if (isLoginPage(page)) {
      return fail("Google login required. See gemini_chat error for instructions.");
    }

    // Navigate to new chat
    await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForTimeout(2_000);

    return ok("New Gemini chat started.");
  } catch (err) {
    return fail(`gemini_new_chat: ${formatError(err)}`);
  }
}

/**
 * gemini_summarize_youtube: Ask Gemini to summarize a YouTube video.
 */
export async function geminiSummarizeYoutube(args: { youtubeUrl: string }): Promise<ToolResult> {
  try {
    // Validate YouTube URL
    const url = new URL(args.youtubeUrl);
    if (!url.hostname.includes("youtube.com") && !url.hostname.includes("youtu.be")) {
      return fail(`Not a YouTube URL: ${args.youtubeUrl}`);
    }

    const page = await ensureGeminiPage();

    if (isLoginPage(page)) {
      return fail("Google login required. See gemini_chat error for instructions.");
    }

    // Start fresh conversation for clean context
    if (page.url() !== GEMINI_URL) {
      await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await page.waitForTimeout(2_000);
    }

    const prompt = `Please watch and summarize this YouTube video in detail. Include the key points, main topics discussed, and any important conclusions.\n\nVideo: ${args.youtubeUrl}`;

    await sendMessageToGemini(page, prompt);
    const response = await waitForGeminiResponse(page);

    return ok(JSON.stringify({
      youtubeUrl: args.youtubeUrl,
      summary: response,
    }, null, 2));
  } catch (err) {
    return fail(`gemini_summarize_youtube: ${formatError(err)}`);
  }
}

// ─── Tool Schemas ────────────────────────────────────────────────────

export const geminiToolDefinitions = [
  {
    name: "gemini_chat",
    description:
      "Send a message to Google Gemini and return its response. Maintains conversation context within the session. " +
      "Requires Google login (persisted in Chrome profile). First-time use: run in headful mode and log in manually.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message: { type: "string", description: "The message/prompt to send to Gemini" },
      },
      required: ["message"],
    },
  },
  {
    name: "gemini_new_chat",
    description:
      "Start a fresh Gemini conversation, clearing previous context. Use before switching topics.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "gemini_summarize_youtube",
    description:
      "Ask Gemini to watch and summarize a YouTube video. Returns structured JSON with the video URL and summary. " +
      "Gemini can access YouTube videos directly and provide detailed summaries.",
    inputSchema: {
      type: "object" as const,
      properties: {
        youtubeUrl: { type: "string", description: "The YouTube video URL to summarize" },
      },
      required: ["youtubeUrl"],
    },
  },
];
