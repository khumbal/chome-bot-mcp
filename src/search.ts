import type { Page } from "playwright";
import { browserManager, dismissCookieConsent, pageCache } from "./browser.js";
import { extractReadableContent, extractLinks, cleanText, truncate } from "./content.js";
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

import { googleSearchAiMode } from "./google.js";

const SEARCH_TIMEOUT_MS = 30_000;

// ─── Sessions ────────────────────────────────────────────────────────

const WIKI_SESSION = "wikipedia";

const ddgMutex = new Mutex();
const newsMutex = new Mutex();
const wikiMutex = new Mutex();

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
  includeLinks?: boolean;
  skipCache?: boolean;
}): Promise<ToolResult> {
  const sessionId = `web-fetch-${Date.now()}`;
  try {
    const parsed = validateUrl(args.url, "url");

    // Check cache before creating a browser session
    if (!args.skipCache && !args.selector) {
      const cached = pageCache.get(parsed.href);
      if (cached) {
        log.debug("Page cache hit", { url: parsed.href });
        const result: Record<string, unknown> = {
          title: cached.title,
          url: parsed.href,
          ...(cached.author ? { author: cached.author } : {}),
          ...(cached.date ? { date: cached.date } : {}),
          ...(cached.siteName ? { siteName: cached.siteName } : {}),
          content: cached.content,
          wordCount: cached.wordCount,
          cached: true,
        };
        return ok(JSON.stringify(result, null, 2));
      }
    }

    const { page } = await browserManager.createSession(sessionId);

    try {
      await page.goto(parsed.href, {
        waitUntil: "domcontentloaded",
        timeout: SEARCH_TIMEOUT_MS,
      });
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});

      // Dismiss cookie banners before extracting content
      await dismissCookieConsent(page);

      const url = page.url();
      let result: Record<string, unknown>;

      if (args.selector) {
        const sel = validateNonEmpty(args.selector, "selector");
        const raw =
          (await page
            .locator(sel)
            .first()
            .textContent({ timeout: 5_000 })
            .catch(() => "")) ?? "";
        const content = truncate(cleanText(raw));
        const title = await page.title().catch(() => "(untitled)");
        result = {
          title,
          url,
          content,
          wordCount: content.split(/\s+/).filter(Boolean).length,
        };
      } else {
        const readable = await extractReadableContent(page);
        result = {
          title: readable.title,
          url,
          ...(readable.author ? { author: readable.author } : {}),
          ...(readable.date ? { date: readable.date } : {}),
          ...(readable.siteName ? { siteName: readable.siteName } : {}),
          content: readable.content,
          wordCount: readable.wordCount,
        };
      }

      // Fallback to full body if extraction returned too little text
      if (((result.content as string) ?? "").trim().length < 50) {
        const raw =
          (await page.locator("body").textContent({ timeout: 5_000 }).catch(() => "")) ?? "";
        const content = truncate(cleanText(raw));
        result.content = content;
        result.wordCount = content.split(/\s+/).filter(Boolean).length;
      }

      if (args.includeLinks) {
        const links = await extractLinks(page);
        result.links = links;
      }

      // Cache for future reuse
      if (!args.selector) {
        pageCache.set(parsed.href, {
          content: result.content as string,
          title: result.title as string,
          ...(result.author ? { author: result.author as string } : {}),
          ...(result.date ? { date: result.date as string } : {}),
          ...(result.siteName ? { siteName: result.siteName as string } : {}),
          wordCount: result.wordCount as number,
        });
      }

      return ok(JSON.stringify(result, null, 2));
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

type Recency = "day" | "week" | "month" | "year" | "any";

const RECENCY_PARAM: Record<Recency, string> = {
  day: "d",
  week: "w",
  month: "m",
  year: "y",
  any: "",
};

export async function duckduckgoSearch(args: {
  query: string;
  maxResults?: number;
  recency?: Recency;
}): Promise<ToolResult> {
  const sessionId = `ddg-${Date.now()}`;
  try {
    const query = validateNonEmpty(args.query, "query");
    const maxResults = Math.max(1, Math.min(args.maxResults ?? 10, 20));
    const recency = args.recency ?? "month";
    const dfParam = RECENCY_PARAM[recency] ? `&df=${RECENCY_PARAM[recency]}` : "";
    const release = await ddgMutex.acquire();

    try {
      const { page } = await browserManager.createSession(sessionId);
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=wt-wt${dfParam}`;

      log.info("DuckDuckGo search", { query, recency });
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: SEARCH_TIMEOUT_MS });
      await page.waitForTimeout(1_500);
      await dismissCookieConsent(page);

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
            recency,
            totalResults: results.length,
            results,
          },
          null,
          2,
        ),
      );
    } finally {
      release();
      await browserManager.destroySession(sessionId).catch(() => {});
    }
  } catch (err) {
    await browserManager.destroySession(sessionId).catch(() => {});
    if (err instanceof ValidationError) return fail(err.message);
    return fail(`duckduckgo_search: ${formatError(err)}`);
  }
}

// ─── news_search ─────────────────────────────────────────────────────

export async function newsSearch(args: {
  query: string;
  maxResults?: number;
  recency?: Recency;
}): Promise<ToolResult> {
  const sessionId = `news-${Date.now()}`;
  try {
    const query = validateNonEmpty(args.query, "query");
    const maxResults = Math.max(1, Math.min(args.maxResults ?? 10, 20));
    const recency = args.recency ?? "week";
    const dfParam = RECENCY_PARAM[recency] ? `&df=${RECENCY_PARAM[recency]}` : "";
    const release = await newsMutex.acquire();

    try {
      const { page } = await browserManager.createSession(sessionId);
      // DuckDuckGo news filter — no CAPTCHA risk
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&iar=news&ia=news${dfParam}`;

      log.info("News search", { query, recency });
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: SEARCH_TIMEOUT_MS });
      await page.waitForTimeout(1_500);
      await dismissCookieConsent(page);

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
            recency,
            totalResults: articles.length,
            articles,
          },
          null,
          2,
        ),
      );
    } finally {
      release();
      await browserManager.destroySession(sessionId).catch(() => {});
    }
  } catch (err) {
    await browserManager.destroySession(sessionId).catch(() => {});
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

      // Redirected directly to an article (but not a "does not exist" page)
      if (!currentUrl.includes("Special:Search")) {
        const isNoArticle = await page.evaluate(() => !!document.querySelector(".noarticletext, #noarticletext")).catch(() => false);

        if (!isNoArticle) {
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

        // Page doesn't exist — fall back to fulltext search
        const fallbackUrl = `https://${lang}.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(query)}&ns0=1&fulltext=1`;
        await page.goto(fallbackUrl, { waitUntil: "domcontentloaded", timeout: SEARCH_TIMEOUT_MS });
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
      }

      // Search results list
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
        includeLinks: {
          type: "boolean",
          description: "Include a list of links found on the page (default: false). Saves a separate browser_list_links call.",
        },
        skipCache: {
          type: "boolean",
          description: "Skip the content cache and force a fresh fetch (default: false). Use when you need the latest version of a page.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "duckduckgo_search",
    description:
      "Search the web using DuckDuckGo. Returns a list of results with title, clean URL, and snippet. " +
      "Good as a supplementary search when Google is unavailable or rate-limited. " +
      "For most queries, prefer google_search_ai_overview as the primary search tool. " +
      "Defaults to results from the past month.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
        maxResults: {
          type: "number",
          description: "Max number of results to return (1–20, default: 10)",
        },
        recency: {
          type: "string",
          enum: ["day", "week", "month", "year", "any"],
          description: "Filter results by recency. Default: 'month'. Use 'any' to disable time filter.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "news_search",
    description:
      "Search for recent news articles on a topic. Returns article titles, sources, URLs, and snippets. Powered by DuckDuckGo News. Defaults to results from the past week.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "News topic or keyword to search" },
        maxResults: {
          type: "number",
          description: "Max number of articles to return (1–20, default: 10)",
        },
        recency: {
          type: "string",
          enum: ["day", "week", "month", "year", "any"],
          description: "Filter news by recency. Default: 'week'. Use 'any' to disable time filter.",
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
  {
    name: "research",
    description:
      "Comprehensive multi-source research tool. Runs DuckDuckGo web search, DuckDuckGo news, Wikipedia, and Google AI Mode IN PARALLEL, " +
      "then combines all results into a single structured report. Use this for any research query instead of calling individual search tools separately. " +
      "Returns web results, news articles, Wikipedia summary, and AI-synthesized answer all at once. " +
      "You can selectively enable/disable sources.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "The research topic or question" },
        recency: {
          type: "string",
          enum: ["day", "week", "month", "year", "any"],
          description: "Filter web/news results by recency. Default: 'month'.",
        },
        sources: {
          type: "object",
          description: "Enable/disable individual sources (all enabled by default)",
          properties: {
            web: { type: "boolean", description: "DuckDuckGo web search (default: true)" },
            news: { type: "boolean", description: "DuckDuckGo news (default: true)" },
            wikipedia: { type: "boolean", description: "Wikipedia lookup (default: true)" },
            googleAi: { type: "boolean", description: "Google AI Mode (default: true)" },
          },
        },
        maxResults: {
          type: "number",
          description: "Max results per source (1–10, default: 5)",
        },
        language: {
          type: "string",
          description: "Wikipedia language code (default: 'en'). Also affects Google hl param.",
        },
        deep: {
          type: "boolean",
          description: "Enable deep research mode (default: false). When true, fetches full content from top 3 web results and includes excerpts in the report.",
        },
      },
      required: ["query"],
    },
  },
] as const;

// ─── Research Meta-Tool ──────────────────────────────────────────────

interface ResearchSources {
  web?: boolean;
  news?: boolean;
  wikipedia?: boolean;
  googleAi?: boolean;
}

export async function research(args: {
  query: string;
  recency?: Recency;
  sources?: ResearchSources;
  maxResults?: number;
  language?: string;
  deep?: boolean;
}): Promise<ToolResult> {
  try {
    const query = validateNonEmpty(args.query, "query");
    const recency = args.recency ?? "month";
    const maxResults = Math.max(1, Math.min(args.maxResults ?? 5, 10));
    const lang = args.language ?? "en";
    const sources: Required<ResearchSources> = {
      web: args.sources?.web ?? true,
      news: args.sources?.news ?? true,
      wikipedia: args.sources?.wikipedia ?? true,
      googleAi: args.sources?.googleAi ?? true,
    };

    log.info("Research", { query, recency, sources, maxResults });

    // Build parallel tasks based on enabled sources
    const tasks: Record<string, Promise<unknown>> = {};

    if (sources.web) {
      tasks.web = duckduckgoSearch({ query, maxResults, recency })
        .then(parseToolResult)
        .catch((err) => ({ error: formatError(err) }));
    }

    if (sources.news) {
      tasks.news = newsSearch({ query, maxResults, recency: recency === "month" ? "week" : recency })
        .then(parseToolResult)
        .catch((err) => ({ error: formatError(err) }));
    }

    if (sources.wikipedia) {
      tasks.wikipedia = wikipediaSearch({ query, language: lang })
        .then(parseToolResult)
        .catch((err) => ({ error: formatError(err) }));
    }

    if (sources.googleAi) {
      tasks.googleAi = googleSearchAiMode({ query, recency, format: "json" })
        .then(parseToolResult)
        .catch((err) => ({ error: formatError(err) }));
    }

    // Run all enabled sources in parallel
    const keys = Object.keys(tasks);
    const results = await Promise.all(Object.values(tasks));

    const report: Record<string, unknown> = { query, recency, sourcesUsed: keys };

    for (let i = 0; i < keys.length; i++) {
      report[keys[i]] = results[i];
    }

    // Deep mode: fetch top URLs from web results for full content
    if (args.deep && report.web && typeof report.web === "object") {
      const webData = report.web as { results?: { url: string; title: string }[] };
      const urls = (webData.results ?? [])
        .map((r) => r.url)
        .filter((url) => url && !url.includes("wikipedia.org"))
        .slice(0, 3);

      if (urls.length > 0) {
        log.info("Deep research: fetching URLs", { count: urls.length });
        const deepResults = await Promise.allSettled(
          urls.map((url) =>
            webFetchContent({ url, skipCache: false })
              .then(parseToolResult)
              .then((data) => {
                const d = data as Record<string, unknown>;
                return {
                  url,
                  title: (d.title as string) ?? "",
                  excerpt: ((d.content as string) ?? "").slice(0, 2_000),
                };
              }),
          ),
        );

        report.deepContent = deepResults
          .filter((r): r is PromiseFulfilledResult<{ url: string; title: string; excerpt: string }> => r.status === "fulfilled")
          .map((r) => r.value);
      }
    }

    return ok(JSON.stringify(report, null, 2));
  } catch (err) {
    if (err instanceof ValidationError) return fail(err.message);
    return fail(`research: ${formatError(err)}`);
  }
}

function parseToolResult(result: ToolResult): unknown {
  if (result.isError) {
    return { error: result.content[0]?.text ?? "Unknown error" };
  }
  try {
    return JSON.parse(result.content[0]?.text ?? "{}");
  } catch {
    return { text: result.content[0]?.text ?? "" };
  }
}
