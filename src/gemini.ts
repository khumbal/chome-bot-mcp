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
  Mutex,
  log,
} from "./shared.js";

const GEMINI_SESSION = "gemini";
const GEMINI_URL = "https://gemini.google.com/app";
const RESPONSE_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 90_000;
const POLL_INTERVAL_MS = 1_500;

// Serialize all Gemini operations — persistent session is shared
const geminiMutex = new Mutex();

// ─── Internal Helpers ────────────────────────────────────────────────

async function ensureGeminiPage(): Promise<Page> {
  // Check existing session health first
  const existingPage = browserManager.getActivePage(GEMINI_SESSION);
  if (existingPage) {
    // Re-navigate if not on Gemini (e.g. page was redirected)
    if (!existingPage.url().includes("gemini.google.com")) {
      log.info("Re-navigating to Gemini");
      await existingPage.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await existingPage.waitForTimeout(2_000);
    }
    return existingPage;
  }

  // Create or recreate persistent session
  log.info("Creating persistent Gemini session");
  const { page } = await browserManager.createPersistentSession(GEMINI_SESSION);

  if (!page.url().includes("gemini.google.com")) {
    await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2_000);
  }

  return page;
}

function isLoginPage(page: Page): boolean {
  const url = page.url();
  return url.includes("accounts.google.com") || url.includes("/signin");
}

const LOGIN_ERROR_MSG =
  "Google login required. Please run the server in headful mode (HEADLESS=false), " +
  "then use browser_navigate to go to https://gemini.google.com and log in manually. " +
  "Your login will be persisted in the Chrome profile directory.";

async function waitForGeminiResponse(page: Page): Promise<string> {
  const startTime = Date.now();
  let lastText = "";
  let stableCount = 0;

  while (Date.now() - startTime < RESPONSE_TIMEOUT_MS) {
    await page.waitForTimeout(POLL_INTERVAL_MS);

    // Check for error banners (rate limit, server error)
    const errorBanner = await detectGeminiError(page);
    if (errorBanner) {
      throw new Error(`Gemini error: ${errorBanner}`);
    }

    const responseText = await extractLatestResponse(page);

    if (responseText && responseText === lastText) {
      stableCount++;
      if (stableCount >= 3) return responseText;
    } else {
      stableCount = 0;
      lastText = responseText ?? "";
    }
  }

  return lastText || "Gemini response timed out (no content received).";
}

async function detectGeminiError(page: Page): Promise<string | null> {
  const errorSelectors = [
    ".error-message",
    "[aria-live='assertive'] .error",
    ".rate-limit-message",
    ".server-error",
  ];

  for (const sel of errorSelectors) {
    try {
      const el = page.locator(sel).first();
      const visible = await el.isVisible({ timeout: 500 }).catch(() => false);
      if (visible) {
        const text = await el.textContent({ timeout: 1_000 }).catch(() => null);
        return text?.trim() || "Unknown Gemini error";
      }
    } catch {
      // Selector not found — continue
    }
  }
  return null;
}

async function extractLatestResponse(page: Page): Promise<string | null> {
  const selectors = [
    "message-content.model-response-text",
    ".model-response-text",
    ".response-container-content",
    ".markdown-main-panel",
    "[data-content-type='response']",
  ];

  for (const sel of selectors) {
    try {
      const elements = page.locator(sel);
      const count = await elements.count().catch(() => 0);
      if (count > 0) {
        const text = await elements.last().textContent({ timeout: 3_000 }).catch(() => null);
        if (text && text.trim().length > 0) return text.trim();
      }
    } catch {
      // Continue to next selector
    }
  }

  // Broad fallback
  try {
    const turns = page.locator(".conversation-turn, .turn-content");
    const turnCount = await turns.count().catch(() => 0);
    if (turnCount > 0) {
      const lastTurn = await turns.last().textContent({ timeout: 3_000 }).catch(() => null);
      if (lastTurn && lastTurn.trim().length > 0) return lastTurn.trim();
    }
  } catch {
    // Fallback failed
  }

  return null;
}

async function sendMessageToGemini(page: Page, message: string): Promise<void> {
  const inputSelectors = [
    'div[contenteditable="true"]',
    '.ql-editor[contenteditable="true"]',
    "textarea",
    ".text-input-field",
  ];

  let inputEl = null;
  for (const sel of inputSelectors) {
    const candidate = page.locator(sel).first();
    const visible = await candidate.isVisible({ timeout: 3_000 }).catch(() => false);
    if (visible) {
      inputEl = candidate;
      break;
    }
  }

  if (!inputEl) {
    throw new Error("Cannot find Gemini input field. The UI may have changed or login is required.");
  }

  await inputEl.click();

  // contenteditable fields don't always work with fill() — use keyboard.insertText
  // which dispatches proper input events
  const tag = await inputEl.evaluate((el) => el.tagName.toLowerCase()).catch(() => "div");
  if (tag === "textarea" || tag === "input") {
    await inputEl.fill(message);
  } else {
    // Clear existing content, then insert
    await page.keyboard.press("Meta+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.insertText(message);
  }

  // Click send button or press Enter
  const sendButton = page
    .locator(
      'button[aria-label="Send message"], button[aria-label="ส่งข้อความ"], button.send-button, button[mattooltip="Send"]',
    )
    .first();
  const hasSendButton = await sendButton.isVisible({ timeout: 2_000 }).catch(() => false);

  if (hasSendButton) {
    await sendButton.click();
  } else {
    await page.keyboard.press("Enter");
  }

  log.debug("Message sent to Gemini");
}

// ─── Tool Implementations ────────────────────────────────────────────

export async function geminiChat(args: { message: string }): Promise<ToolResult> {
  const release = await geminiMutex.acquire();
  try {
    const message = validateNonEmpty(args.message, "message");

    const page = await ensureGeminiPage();
    if (isLoginPage(page)) return fail(LOGIN_ERROR_MSG);

    await sendMessageToGemini(page, message);
    const response = await waitForGeminiResponse(page);

    return ok(response);
  } catch (err) {
    if (err instanceof ValidationError) return fail(err.message);
    return fail(`gemini_chat: ${formatError(err)}`);
  } finally {
    release();
  }
}

export async function geminiNewChat(): Promise<ToolResult> {
  const release = await geminiMutex.acquire();
  try {
    const page = await ensureGeminiPage();
    if (isLoginPage(page)) return fail(LOGIN_ERROR_MSG);

    await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForTimeout(2_000);

    return ok("New Gemini chat started.");
  } catch (err) {
    return fail(`gemini_new_chat: ${formatError(err)}`);
  } finally {
    release();
  }
}

export async function geminiSummarizeYoutube(args: { youtubeUrl: string }): Promise<ToolResult> {
  const release = await geminiMutex.acquire();
  try {
    const url = validateUrl(args.youtubeUrl, "youtubeUrl");
    if (!url.hostname.endsWith("youtube.com") && url.hostname !== "youtu.be") {
      return fail(`Not a YouTube URL: ${args.youtubeUrl}`);
    }

    const page = await ensureGeminiPage();
    if (isLoginPage(page)) return fail(LOGIN_ERROR_MSG);

    // Start fresh conversation for clean summary context
    if (!page.url().startsWith(GEMINI_URL)) {
      await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await page.waitForTimeout(2_000);
    }

    const prompt =
      "Please watch and summarize this YouTube video in detail. " +
      "Include the key points, main topics discussed, and any important conclusions.\n\n" +
      `Video: ${url.href}`;

    await sendMessageToGemini(page, prompt);
    const response = await waitForGeminiResponse(page);

    return ok(
      JSON.stringify({ youtubeUrl: url.href, summary: response }, null, 2),
    );
  } catch (err) {
    if (err instanceof ValidationError) return fail(err.message);
    return fail(`gemini_summarize_youtube: ${formatError(err)}`);
  } finally {
    release();
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
