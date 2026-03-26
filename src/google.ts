import type { Page } from "playwright";
import { browserManager } from "./browser.js";
import {
  type ToolResult,
  ok,
  fail,
  formatError,
  validateNonEmpty,
  ValidationError,
  Mutex,
  log,
} from "./shared.js";

const SESSION_PREFIX = "google-search-";
const GOOGLE_SESSION = "google";
const SEARCH_TIMEOUT_MS = 30_000;
const MAX_CONTENT_LENGTH = 5_000;

// Mutex prevents concurrent Google searches from interfering
const googleMutex = new Mutex();
let sessionCounter = 0;

// ─── Shared Google Session ───────────────────────────────────────────

async function ensureGooglePage(): Promise<Page> {
  // Reuse existing persistent session to keep cookies (anti-CAPTCHA)
  const existingPage = browserManager.getActivePage(GOOGLE_SESSION);
  if (existingPage) return existingPage;

  log.info("Creating persistent Google session");
  const { page } = await browserManager.createPersistentSession(GOOGLE_SESSION);
  return page;
}

// ─── Google AI Overview ──────────────────────────────────────────────

export async function googleSearchAiOverview(args: { query: string }): Promise<ToolResult> {
  try {
    const query = validateNonEmpty(args.query, "query");
    const release = await googleMutex.acquire();

    try {
      const page = await ensureGooglePage();

      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`;
      log.info("Google search", { query });

      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: SEARCH_TIMEOUT_MS });
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(2_000);

      // Check for CAPTCHA / block page
      const captchaResult = await detectCaptcha(page);
      if (captchaResult) {
        log.warn("Google CAPTCHA detected", { url: page.url() });
        return fail(captchaResult);
      }

      // Strategy 1: Click AI Mode tab
      const aiModeResult = await tryAiMode(page, query);
      if (aiModeResult) return aiModeResult;

      // Strategy 2: Extract AI Overview / Featured Snippet from results page
      const overviewResult = await tryAiOverview(page, query);
      if (overviewResult) return overviewResult;

      // Strategy 3: Fallback to search results
      const fallbackResult = await trySearchResults(page, query);
      if (fallbackResult) return fallbackResult;

      return fail(`No search results found for: "${query}". The page may have loaded differently than expected.`);
    } finally {
      release();
    }
  } catch (err) {
    if (err instanceof ValidationError) return fail(err.message);
    return fail(`google_search_ai_overview: ${formatError(err)}`);
  }
}

// ─── Strategies ──────────────────────────────────────────────────────

async function detectCaptcha(page: Page): Promise<string | null> {
  const url = page.url();
  if (url.includes("/sorry/") || url.includes("captcha")) {
    return "Google CAPTCHA detected. The IP may be rate-limited. Try again later or use a different network.";
  }

  // Check for in-page reCAPTCHA or block overlay
  try {
    const hasRecaptcha = await page
      .locator('iframe[src*="recaptcha"], #recaptcha, .g-recaptcha')
      .first()
      .isVisible({ timeout: 1_000 })
      .catch(() => false);

    if (hasRecaptcha) {
      return "Google reCAPTCHA detected on page. Please solve it manually in the browser, then retry.";
    }

    const bodyText = await page.locator("body").textContent({ timeout: 1_000 }).catch(() => "") ?? "";
    if (bodyText.includes("unusual traffic") && bodyText.includes("not a robot")) {
      return "Google blocked the request (unusual traffic detected). Try again later.";
    }
  } catch {
    // Detection failed — assume no CAPTCHA
  }

  return null;
}

async function tryAiMode(page: Page, query: string): Promise<ToolResult | null> {
  try {
    const aiModeLink = page.locator('a:has-text("AI Mode"), a:has-text("โหมด AI")').first();
    const hasAiMode = await aiModeLink.isVisible({ timeout: 3_000 }).catch(() => false);

    if (!hasAiMode) return null;

    log.debug("Clicking AI Mode tab");
    await aiModeLink.click();
    await page.waitForLoadState("domcontentloaded", { timeout: SEARCH_TIMEOUT_MS });

    const captchaResult = await detectCaptcha(page);
    if (captchaResult) return fail(captchaResult);

    // Use smart polling — same approach as googleSearchAiMode
    const content = await waitForAiModeResponse(page);
    if (!content) return null;

    return ok(JSON.stringify({
      source: "google_ai_mode",
      query,
      content: truncate(content),
    }, null, 2));
  } catch (err) {
    log.warn("AI Mode extraction failed, falling back", { error: formatError(err) });
    return null;
  }
}

async function tryAiOverview(page: Page, query: string): Promise<ToolResult | null> {
  const content = await extractFirstMatch(page, [
    '[data-attrid="wa:/description"]',  // featured snippet / AI overview
    ".hgKElc",                           // featured snippet text
    ".wDYxhc",                           // AI overview section
    ".mod [data-md]",                    // markdown-based AI overview
    ".xpdopen .kno-rdesc",              // knowledge card
  ]);

  if (!content) return null;

  return ok(JSON.stringify({
    source: "google_ai_overview",
    query,
    content: truncate(content),
  }, null, 2));
}

async function trySearchResults(page: Page, query: string): Promise<ToolResult | null> {
  const content = await extractFirstMatch(page, ["#rso", "#search"]);
  if (!content) return null;

  return ok(JSON.stringify({
    source: "google_search_results",
    query,
    content: truncate(content),
    note: "AI Overview not available for this query. Returning top search results.",
  }, null, 2));
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function extractFirstMatch(page: Page, selectors: string[]): Promise<string | null> {
  for (const sel of selectors) {
    try {
      const text = await page
        .locator(sel)
        .first()
        .textContent({ timeout: 3_000 });
      if (text && text.trim().length > 30) {
        return text.trim();
      }
    } catch {
      // Selector not found or timeout — try next
    }
  }
  return null;
}

function truncate(text: string): string {
  if (text.length <= MAX_CONTENT_LENGTH) return text;
  return text.substring(0, MAX_CONTENT_LENGTH) + `\n\n[truncated — ${text.length} total chars]`;
}

// ─── Google AI Mode (Direct) ─────────────────────────────────────────

const AI_MODE_TIMEOUT_MS = 60_000;
const AI_MODE_POLL_MS = 1_500;

export async function googleSearchAiMode(args: { query: string }): Promise<ToolResult> {
  try {
    const query = validateNonEmpty(args.query, "query");
    const release = await googleMutex.acquire();

    try {
      const page = await ensureGooglePage();

      // udm=50 goes directly to Google AI Mode
      const aiModeUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=50&hl=en`;
      log.info("Google AI Mode search", { query });

      await page.goto(aiModeUrl, { waitUntil: "domcontentloaded", timeout: SEARCH_TIMEOUT_MS });

      // Check for CAPTCHA immediately
      const captchaResult = await detectCaptcha(page);
      if (captchaResult) {
        log.warn("Google CAPTCHA detected", { url: page.url() });
        return fail(captchaResult);
      }

      // Wait for AI Mode response to stream in and stabilize
      const content = await waitForAiModeResponse(page);

      if (!content) {
        return fail(
          `AI Mode returned no content for: "${query}". ` +
          "Google may not support AI Mode for this query or region.",
        );
      }

      return ok(
        JSON.stringify(
          {
            source: "google_ai_mode",
            query,
            content: truncate(content),
          },
          null,
          2,
        ),
      );
    } finally {
      release();
    }
  } catch (err) {
    if (err instanceof ValidationError) return fail(err.message);
    return fail(`google_search_ai_mode: ${formatError(err)}`);
  }
}

async function waitForAiModeResponse(page: Page): Promise<string | null> {
  const startTime = Date.now();
  let lastText = "";
  let stableCount = 0;

  // AI Mode selectors — discovered from actual DOM inspection (2026-03)
  const selectors = [
    "#aim-chrome-initial-inline-async-container",  // main AI Mode response container (has ID)
    ".Zkbeff",            // AI Mode response wrapper
    ".CKgc1d",            // response content block
    ".pWvJNd",            // inner response text
    ".mZJni",             // response section
  ];

  while (Date.now() - startTime < AI_MODE_TIMEOUT_MS) {
    await page.waitForTimeout(AI_MODE_POLL_MS);

    // Check CAPTCHA mid-stream
    const captcha = await detectCaptcha(page);
    if (captcha) return null;

    const text = await extractFirstMatch(page, selectors);
    if (!text) continue;

    if (text === lastText) {
      stableCount++;
      // Stable for 3 consecutive polls → done streaming
      if (stableCount >= 3) {
        log.debug("AI Mode response stabilized", { chars: text.length });
        return text;
      }
    } else {
      stableCount = 0;
      lastText = text;
    }
  }

  // Timeout — return whatever we collected
  return lastText.length > 30 ? lastText : null;
}

// ─── Tool Schema ─────────────────────────────────────────────────────

export const googleToolDefinitions = [
  {
    name: "google_search_ai_overview",
    description:
      "Search Google and extract the AI Overview / AI Mode summary for a given query. " +
      "Falls back to top search results if AI Overview is unavailable. " +
      "Returns structured JSON with source type and content.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "The search query (non-empty string)" },
      },
      required: ["query"],
    },
  },
  {
    name: "google_search_ai_mode",
    description:
      "Search Google using AI Mode directly (udm=50). Goes straight to Google's AI-generated answer " +
      "instead of regular search results. The response streams in and is captured once stable. " +
      "Best for questions that benefit from AI synthesis. Returns structured JSON.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "The search query (non-empty string)" },
      },
      required: ["query"],
    },
  },
];
