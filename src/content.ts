import type { Page } from "playwright";

const MAX_CONTENT_LENGTH = 8_000;

// ─── Types ───────────────────────────────────────────────────────────

export interface ReadableContent {
  title: string;
  content: string;
  author?: string;
  date?: string;
  siteName?: string;
  wordCount: number;
}

export interface ExtractLinksOptions {
  selector?: string;
  filter?: "internal" | "external" | "all";
  maxResults?: number;
}

export interface LinkInfo {
  text: string;
  href: string;
  isInternal: boolean;
}

// ─── Text Utilities ──────────────────────────────────────────────────

export function cleanText(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncate(text: string, max = MAX_CONTENT_LENGTH): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n...[truncated at ${max} chars]`;
}

// ─── Readable Content Extraction ─────────────────────────────────────

const NOISE_SELECTORS = [
  "nav", "footer", "aside", "header", "script", "style", "noscript",
  "svg", "iframe", '[role="navigation"]', '[role="banner"]',
  '[role="contentinfo"]', ".sidebar", ".ad", ".ads", ".advertisement",
  ".cookie-banner", ".cookie-consent", ".menu", ".nav", ".footer",
  ".header", ".social-share", ".share-buttons", ".comments",
  ".related-articles", "#comments",
].join(", ");

export async function extractReadableContent(page: Page): Promise<ReadableContent> {
  const raw = await page.evaluate((noiseSelectors: string) => {
    // ── Metadata ──
    const meta = (name: string): string =>
      document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)
        ?.getAttribute("content") ?? "";

    const title =
      meta("og:title") || document.title || "";
    const author =
      meta("author") || meta("article:author") || "";
    const date =
      meta("article:published_time") || meta("datePublished") || "";
    const siteName = meta("og:site_name") || "";

    // ── Clone body and strip noise ──
    const clone = document.body.cloneNode(true) as HTMLElement;
    for (const el of Array.from(clone.querySelectorAll(noiseSelectors))) {
      el.remove();
    }

    // ── Score block elements by <p> count ──
    let bestEl: HTMLElement | null = null;
    let bestScore = 0;

    for (const el of Array.from(
      clone.querySelectorAll<HTMLElement>("article, main, section, div"),
    )) {
      const paragraphs = el.querySelectorAll("p");
      let score = 0;
      for (const p of Array.from(paragraphs)) {
        if ((p.textContent?.length ?? 0) > 40) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestEl = el;
      }
    }

    const text = bestEl ? bestEl.innerText : clone.innerText;

    return { title, author, date, siteName, text };
  }, NOISE_SELECTORS);

  const content = truncate(cleanText(raw.text));
  const wordCount = content.split(/\s+/).filter(Boolean).length;

  return {
    title: raw.title,
    content,
    ...(raw.author ? { author: raw.author } : {}),
    ...(raw.date ? { date: raw.date } : {}),
    ...(raw.siteName ? { siteName: raw.siteName } : {}),
    wordCount,
  };
}

// ─── Link Extraction ─────────────────────────────────────────────────

export async function extractLinks(
  page: Page,
  options?: ExtractLinksOptions,
): Promise<LinkInfo[]> {
  const selector = options?.selector ?? "body";
  const filter = options?.filter ?? "all";
  const maxResults = options?.maxResults ?? 50;

  const links = await page.evaluate(
    ({ selector, maxResults }: { selector: string; maxResults: number }) => {
      const root = document.querySelector(selector);
      if (!root) return [];

      const origin = window.location.origin;
      const seen = new Set<string>();
      const results: { text: string; href: string; isInternal: boolean }[] = [];

      for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
        const raw = a.getAttribute("href") ?? "";
        if (
          raw.startsWith("#") ||
          raw.startsWith("javascript:") ||
          raw.startsWith("mailto:") ||
          raw.startsWith("tel:")
        ) continue;

        // Resolve relative URLs
        let href: string;
        try {
          href = new URL(raw, window.location.href).href;
        } catch {
          continue;
        }

        if (seen.has(href)) continue;
        seen.add(href);

        const text = (a.textContent?.trim() ?? "").slice(0, 200);
        const isInternal = href.startsWith(origin);

        results.push({ text, href, isInternal });
        if (results.length >= maxResults) break;
      }

      return results;
    },
    { selector, maxResults },
  );

  if (filter === "all") return links;
  return links.filter((l) =>
    filter === "internal" ? l.isInternal : !l.isInternal,
  );
}
