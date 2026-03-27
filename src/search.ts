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

const SEARCH_TIMEOUT_MS = 30_000;
const MAX_CONTENT_LENGTH = 8_000;

// ─── Sessions ────────────────────────────────────────────────────────

const DDG_SESSION = "duckduckgo";
const NEWS_SESSION = "news-search";
const WIKI_SESSION = "wikipedia";

const ddgMutex = new Mutex();
const newsMutex = new Mutex();
const wikiMutex = new Mutex();

async function ensureDdgPage(): Promise<Page> {
  const existing = browserManager.getActivePage(DDG_SESSION);
  if (existing) return existing;
  const { page } = await browserManager.createPersistentSession(DDG_SESSION);
  return page;
}

async function ensureNewsPage(): Promise<Page> {
  const existing = browserManager.getActivePage(NEWS_SESSION);
  if (existing) return existing;
  const { page } = await browserManager.createPersistentSession(NEWS_SESSION);
  return page;
}

async function ensureWikiPage(): Promise<Page> {
  const existing = browserManager.getActivePage(WIKI_SESSION);
  if (existing) return existing;
  const { page } = await browserManager.createPersistentSession(WIKI_SESSION);
  return page;
}

// ─── web_fetch_content ───────────────────────────────────────────────

export async function webFetchContent(args: {
  url: string;
  selector?: string;
}): Promise<ToolResult> {
  const sessionId = `web-fetch-${Date.now()}`;
  try {
    const parsed = validateUrl(args.url, "url");
    const { page } = await browserManager.createSession(sessionId);

    try {
      await page.goto(parsed.href, {
        waitUntil: "domcontentloaded",
        timeout: SEARCH_TIMEOUT_MS,
      });
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});

      const title = await page.title().catch(() => "(untitled)");
      const url = page.url();

      let content = "";

      if (args.selector) {
        const sel = validateNonEmpty(args.selector, "selector");
        content =
          (await page
            .locator(sel)
            .first()
            .textContent({ timeout: 5_000 })
            .catch(() => "")) ?? "";
      } else {
        content = await extractArticleContent(page);
      }

      // Fallback to full body if extraction returned too little text
      if (content.trim().length < 50) {
        content =
          (await page.locator("body").textContent({ timeout: 5_000 }).catch(() => "")) ?? "";
      }

      const cleaned = cleanText(content);

      return ok(
        JSON.stringify(
          {
            title,
            url,
            content: truncate(cleaned),
            wordCount: cleaned.split(/\s+/).filter(Boolean).length,
          },
          null,
          2,
        ),
      );
    } finally {
      await browserManager.destroySession(sessionId).catch(() => {});
    }
  } catch (err) {
    await browserManager.destroySession(sessionId).catch(() => {});
    if (err instanceof ValidationError) return fail(err.message);
    return fail(`web_fetch_content: ${formatError(err)}`);
  }
}

// ─── duckduckgo_search ───────────────────────────────────────────────

export async function duckduckgoSearch(args: {
  query: string;
  maxResults?: number;
}): Promise<ToolResult> {
  try {
    const query = validateNonEmpty(args.query, "query");
    const maxResults = Math.max(1, Math.min(args.maxResults ?? 10, 20));
    const release = await ddgMutex.acquire();

    try {
      const page = await ensureDdgPage();
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=wt-wt`;

      log.info("DuckDuckGo search", { query });
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: SEARCH_TIMEOUT_MS });
      await page.waitForTimeout(1_500);

      const results = await page.evaluate((max: number) => {
        const items: { title: string; url: string; snippet: string }[] = [];
        const resultEls = document.querySelectorAll(".result");

        for (const el of Array.from(resultEls).slice(0, max)) {
          const titleEl = el.querySelector<HTMLAnchorElement>(".result__title a");
          const snippetEl = el.querySelector(".result__snippet");

          if (!titleEl) continue;

          // DDG redirect links contain the real URL as a query param
          const rawHref = titleEl.href ?? "";
          const match = rawHref.match(/[?&]uddg=([^&]+)/);
          const cleanUrl = match ? decodeURIComponent(match[1]) : rawHref;

          items.push({
            title: titleEl.textContent?.trim() ?? "",
            url: cleanUrl,
            snippet: snippetEl?.textContent?.trim() ?? "",
          });
        }

        return items;
      }, maxResults);

      if (results.length === 0) {
        return fail(`No results found for: "${query}"`);
      }

      return ok(
        JSON.stringify(
          {
            query,
            totalResults: results.length,
            results,
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
    return fail(`duckduckgo_search: ${formatError(err)}`);
  }
}

// ─── news_search ─────────────────────────────────────────────────────

export async function newsSearch(args: {
  query: string;
  maxResults?: number;
}): Promise<ToolResult> {
  try {
    const query = validateNonEmpty(args.query, "query");
    const maxResults = Math.max(1, Math.min(args.maxResults ?? 10, 20));
    const release = await newsMutex.acquire();

    try {
      const page = await ensureNewsPage();
      // DuckDuckGo news filter — no CAPTCHA risk
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&iar=news&ia=news`;

      log.info("News search", { query });
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: SEARCH_TIMEOUT_MS });
      await page.waitForTimeout(1_500);

      const articles = await page.evaluate((max: number) => {
        const items: { title: string; url: string; snippet: string; source: string }[] = [];
        const resultEls = document.querySelectorAll(".result");

        for (const el of Array.from(resultEls).slice(0, max)) {
          const titleEl = el.querySelector<HTMLAnchorElement>(".result__title a");
          const snippetEl = el.querySelector(".result__snippet");
          const sourceEl = el.querySelector(".result__url span, .result__extras span");

          if (!titleEl) continue;

          const rawHref = titleEl.href ?? "";
          const match = rawHref.match(/[?&]uddg=([^&]+)/);
          const cleanUrl = match ? decodeURIComponent(match[1]) : rawHref;

          items.push({
            title: titleEl.textContent?.trim() ?? "",
            url: cleanUrl,
            snippet: snippetEl?.textContent?.trim() ?? "",
            source: sourceEl?.textContent?.trim() ?? "",
          });
        }

        return items;
      }, maxResults);

      if (articles.length === 0) {
        return fail(`No news found for: "${query}"`);
      }

      return ok(
        JSON.stringify(
          {
            query,
            totalResults: articles.length,
            articles,
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
    return fail(`news_search: ${formatError(err)}`);
  }
}

// ─── wikipedia_search ────────────────────────────────────────────────

export async function wikipediaSearch(args: {
  query: string;
  language?: string;
}): Promise<ToolResult> {
  try {
    const query = validateNonEmpty(args.query, "query");
    // Only allow valid language codes (letters only, no injection)
    const lang = /^[a-z]{2,10}$/.test(args.language ?? "en") ? (args.language ?? "en") : "en";
    const release = await wikiMutex.acquire();

    try {
      const page = await ensureWikiPage();
      const searchUrl = `https://${lang}.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(query)}&ns0=1&go=Go`;

      log.info("Wikipedia search", { query, lang });
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: SEARCH_TIMEOUT_MS });
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});

      const currentUrl = page.url();
      const title = await page.title().catch(() => "(untitled)");

      // Redirected directly to an article
      if (!currentUrl.includes("Special:Search")) {
        const content = await extractWikipediaContent(page);
        return ok(
          JSON.stringify(
            {
              title,
              url: currentUrl,
              type: "article",
              content: truncate(content),
            },
            null,
            2,
          ),
        );
      }

      // Returned a search results list
      const results = await page.evaluate(() => {
        const items: { title: string; url: string; snippet: string }[] = [];
        const resultEls = document.querySelectorAll(".mw-search-result");

        for (const el of Array.from(resultEls).slice(0, 8)) {
          const titleEl = el.querySelector<HTMLAnchorElement>(".mw-search-result-heading a");
          const snippetEl = el.querySelector(".searchresult");

          if (!titleEl) continue;
          items.push({
            title: titleEl.textContent?.trim() ?? "",
            url: titleEl.href ?? "",
            snippet: snippetEl?.textContent?.trim() ?? "",
          });
        }

        return items;
      });

      if (results.length === 0) {
        return fail(`No Wikipedia articles found for: "${query}"`);
      }

      return ok(
        JSON.stringify(
          {
            query,
            type: "search_results",
            results,
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
    return fail(`wikipedia_search: ${formatError(err)}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function extractArticleContent(page: Page): Promise<string> {
  const selectors = [
    "article",
    '[role="main"] article',
    ".article-content",
    ".article-body",
    ".post-content",
    ".entry-content",
    ".content-body",
    ".story-body",
    ".article__body",
    '[role="main"]',
    "main",
    "#content article",
  ];

  for (const sel of selectors) {
    try {
      const text = await page
        .locator(sel)
        .first()
        .textContent({ timeout: 2_000 });
      if (text && text.trim().length > 100) return text.trim();
    } catch {
      // Try next selector
    }
  }

  return "";
}

async function extractWikipediaContent(page: Page): Promise<string> {
  try {
    const paragraphs = await page
      .locator(".mw-body-content p")
      .allTextContents();
    return paragraphs
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .join("\n\n");
  } catch {
    return (
      (await page
        .locator("#mw-content-text")
        .textContent({ timeout: 5_000 })
        .catch(() => "")) ?? ""
    );
  }
}

function cleanText(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncate(text: string, max = MAX_CONTENT_LENGTH): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n...[truncated at ${max} chars]`;
}

// ─── Tool Schemas (MCP ListTools) ────────────────────────────────────

export const searchToolDefinitions = [
  {
    name: "web_fetch_content",
    description:
      "Fetch a URL and extract the main readable content (article, blog post, research paper, news story). Best for reading the full text of a specific page. Returns title, URL, cleaned content, and word count.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "The URL to fetch content from (http/https only)" },
        selector: {
          type: "string",
          description:
            "Optional CSS selector to extract a specific section. If omitted, auto-detects article content.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "duckduckgo_search",
    description:
      "Search the web using DuckDuckGo. Returns a list of results with title, clean URL, and snippet. Good for general web search without CAPTCHA friction. Use this as the primary web search tool.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
        maxResults: {
          type: "number",
          description: "Max number of results to return (1–20, default: 10)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "news_search",
    description:
      "Search for recent news articles on a topic. Returns article titles, sources, URLs, and snippets. Powered by DuckDuckGo News.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "News topic or keyword to search" },
        maxResults: {
          type: "number",
          description: "Max number of articles to return (1–20, default: 10)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "wikipedia_search",
    description:
      "Search Wikipedia and return an article summary or a list of matching articles. Useful for factual information, definitions, biographies, and research background. Supports all Wikipedia language editions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Title or topic to search on Wikipedia",
        },
        language: {
          type: "string",
          description:
            "Wikipedia language code (default: 'en'). Examples: 'th' for Thai, 'ja' for Japanese, 'zh' for Chinese.",
        },
      },
      required: ["query"],
    },
  },
] as const;
