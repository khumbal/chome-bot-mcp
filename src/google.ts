import { browserManager } from "./browser.js";

const SESSION_ID = "google-search";
const SEARCH_TIMEOUT_MS = 15_000;

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

/**
 * google_search_ai_overview:
 * 1. Navigate to Google
 * 2. Search the query
 * 3. Click "AI mode" tab if available, otherwise extract from standard results
 * 4. Return AI Overview text
 */
export async function googleSearchAiOverview(args: { query: string }): Promise<ToolResult> {
  try {
    const { context, page } = await browserManager.createSession(SESSION_ID);

    // Navigate to Google search directly with query
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(args.query)}`;
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: SEARCH_TIMEOUT_MS });
    await page.waitForTimeout(2_000);

    // Check if we hit CAPTCHA
    if (page.url().includes("/sorry/")) {
      await browserManager.destroySession(SESSION_ID);
      return fail("Google CAPTCHA detected. Try again later or use headful mode (HEADLESS=false).");
    }

    // Strategy 1: Try clicking "AI Mode" tab for full AI overview
    const aiModeLink = page.locator('a:has-text("AI Mode"), a:has-text("โหมด AI")').first();
    const hasAiMode = await aiModeLink.isVisible({ timeout: 3_000 }).catch(() => false);

    if (hasAiMode) {
      await aiModeLink.click();
      await page.waitForLoadState("domcontentloaded", { timeout: SEARCH_TIMEOUT_MS });
      // Wait for AI content to stream/render
      await page.waitForTimeout(8_000);

      // Extract AI mode response — try multiple known selectors
      const aiContent = await extractFirstMatch(page, [
        ".XbIp4e",     // AI mode response container
        ".wDYxhc",     // AI overview section
        '[data-md]',   // markdown content
        "#rso",        // fallback: main results
      ]);

      if (aiContent) {
        await browserManager.destroySession(SESSION_ID);
        return ok(JSON.stringify({
          source: "google_ai_mode",
          query: args.query,
          content: aiContent,
        }, null, 2));
      }
    }

    // Strategy 2: Extract from standard search results page
    const overviewContent = await extractFirstMatch(page, [
      '[data-attrid="wa:/description"]',  // featured snippet/AI overview
      ".hgKElc",                           // featured snippet text
      ".wDYxhc",                           // AI overview section
      ".mod [data-md]",                    // markdown-based AI overview
      ".xpdopen .kno-rdesc",              // knowledge card
    ]);

    if (overviewContent) {
      await browserManager.destroySession(SESSION_ID);
      return ok(JSON.stringify({
        source: "google_ai_overview",
        query: args.query,
        content: overviewContent,
      }, null, 2));
    }

    // Strategy 3: Fallback — get top search results text
    const searchResults = await extractFirstMatch(page, ["#rso"]);
    await browserManager.destroySession(SESSION_ID);

    if (searchResults) {
      // Trim to reasonable length for LLM consumption
      const trimmed = searchResults.substring(0, 3000);
      return ok(JSON.stringify({
        source: "google_search_results",
        query: args.query,
        content: trimmed,
        note: "AI Overview not available for this query, returning top search results.",
      }, null, 2));
    }

    return fail(`No search results found for: "${args.query}"`);
  } catch (err) {
    await browserManager.destroySession(SESSION_ID).catch(() => {});
    return fail(`google_search_ai_overview: ${formatError(err)}`);
  }
}

async function extractFirstMatch(
  page: import("playwright").Page,
  selectors: string[],
): Promise<string | null> {
  for (const sel of selectors) {
    const text = await page
      .locator(sel)
      .first()
      .textContent({ timeout: 3_000 })
      .catch(() => null);
    if (text && text.trim().length > 30) {
      return text.trim();
    }
  }
  return null;
}

// ─── Tool Schema ─────────────────────────────────────────────────────

export const googleToolDefinitions = [
  {
    name: "google_search_ai_overview",
    description:
      "Search Google and extract the AI Overview / AI Mode summary for a given query. Falls back to top search results if AI Overview is unavailable. Returns structured JSON with source type and content.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "The search query" },
      },
      required: ["query"],
    },
  },
];
