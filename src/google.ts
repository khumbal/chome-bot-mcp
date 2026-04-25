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

export interface Reference {
  title: string;
  url: string;
}

export type GoogleSource = "google_ai_overview" | "google_ai_mode" | "google_search_results";
export type GoogleResponseFormat = "json" | "markdown";
export type GoogleFollowUpMode = "always" | "if_short";

export interface GoogleSearchArgs {
  query?: unknown;
  recency?: unknown;
  format?: unknown;
  followUpPrompt?: unknown;
  followUpMode?: unknown;
  minContentLength?: unknown;
}

export interface GoogleRefinement {
  prompt: string;
  content: string;
  timedOut?: boolean;
}

export interface GoogleResultPayload {
  source: GoogleSource;
  query: string;
  content: string;
  references: Reference[];
  refinements?: GoogleRefinement[];
  note?: string;
}

interface RawReference {
  title: string;
  url: string;
}

interface AiModeWaitResult {
  content: string | null;
  captchaMessage?: string;
  errorMessage?: string;
  timedOut: boolean;
}

interface AiModeSearchOptions {
  fallbackOnEmpty?: boolean;
  followUp?: AiModeFollowUpConfig;
}

export interface AiModeFollowUpConfig {
  prompt: string;
  mode: GoogleFollowUpMode;
  minContentLength: number;
}

// Mutex prevents concurrent Google searches from interfering
const googleMutex = new Mutex();
let sessionCounter = 0;

export type GoogleRecency = "day" | "week" | "month" | "year" | "any";

const DEFAULT_RECENCY: GoogleRecency = "month";
const DEFAULT_RESPONSE_FORMAT: GoogleResponseFormat = "markdown";
const GOOGLE_SEARCH_URL = "https://www.google.com/search";
const MIN_EXTRACTED_TEXT_LENGTH = 30;
const GOOGLE_NAVIGATION_ATTEMPTS = 2;
const GOOGLE_RESPONSE_FORMATS = ["json", "markdown"] as const;
const GOOGLE_FOLLOW_UP_MODES = ["always", "if_short"] as const;
const DEFAULT_FOLLOW_UP_MIN_CONTENT_LENGTH = 1_200;
const MAX_FOLLOW_UP_PROMPT_LENGTH = 2_000;
const AI_MODE_ERROR_PATTERNS = [
  "something went wrong and the content wasn't generated",
  "something went wrong",
  "content wasn't generated",
] as const;

const GOOGLE_RECENCY_PARAM: Record<GoogleRecency, string> = {
  day: "qdr:d",
  week: "qdr:w",
  month: "qdr:m",
  year: "qdr:y",
  any: "",
};

function validateRecency(value: unknown): GoogleRecency {
  if (value === undefined) return DEFAULT_RECENCY;
  if (typeof value === "string" && Object.hasOwn(GOOGLE_RECENCY_PARAM, value)) return value as GoogleRecency;
  throw new ValidationError(`"recency" must be one of: day, week, month, year, any.`);
}

function validateResponseFormat(value: unknown): GoogleResponseFormat {
  if (value === undefined) return DEFAULT_RESPONSE_FORMAT;
  if (typeof value === "string" && (GOOGLE_RESPONSE_FORMATS as readonly string[]).includes(value)) {
    return value as GoogleResponseFormat;
  }
  throw new ValidationError(`"format" must be one of: json, markdown.`);
}

function validateFollowUpConfig(args: GoogleSearchArgs): AiModeFollowUpConfig | undefined {
  if (args.followUpPrompt === undefined) return undefined;

  const prompt = validateNonEmpty(args.followUpPrompt, "followUpPrompt");
  if (prompt.length > MAX_FOLLOW_UP_PROMPT_LENGTH) {
    throw new ValidationError(`"followUpPrompt" must be ${MAX_FOLLOW_UP_PROMPT_LENGTH} characters or fewer.`);
  }

  const mode = validateFollowUpMode(args.followUpMode);
  const minContentLength = validateMinContentLength(args.minContentLength);

  return { prompt, mode, minContentLength };
}

function validateFollowUpMode(value: unknown): GoogleFollowUpMode {
  if (value === undefined) return "always";
  if (typeof value === "string" && (GOOGLE_FOLLOW_UP_MODES as readonly string[]).includes(value)) {
    return value as GoogleFollowUpMode;
  }
  throw new ValidationError(`"followUpMode" must be one of: always, if_short.`);
}

function validateMinContentLength(value: unknown): number {
  if (value === undefined) return DEFAULT_FOLLOW_UP_MIN_CONTENT_LENGTH;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`"minContentLength" must be a finite number.`);
  }
  return Math.max(MIN_EXTRACTED_TEXT_LENGTH, Math.min(Math.floor(value), MAX_CONTENT_LENGTH));
}

export function shouldRunAiModeFollowUp(content: string, config: AiModeFollowUpConfig): boolean {
  if (config.mode === "always") return true;
  return normalizeExtractedText(content).length < config.minContentLength;
}

export function detectAiModeErrorText(text: string): string | null {
  const normalized = normalizeExtractedText(text).toLowerCase();
  if (AI_MODE_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return "Google AI Mode returned an internal error and did not generate content.";
  }
  return null;
}

export function buildGoogleSearchUrl(query: string, recency: GoogleRecency, directAiMode = false): string {
  const params = new URLSearchParams({ q: query, hl: "en" });
  if (directAiMode) params.set("udm", "50");

  const tbs = GOOGLE_RECENCY_PARAM[recency];
  if (tbs) params.set("tbs", tbs);

  return `${GOOGLE_SEARCH_URL}?${params.toString()}`;
}

function toolResponse(payload: GoogleResultPayload, format: GoogleResponseFormat): ToolResult {
  return ok(format === "markdown" ? googleResultToMarkdown(payload) : JSON.stringify(payload, null, 2));
}

export function googleResultToMarkdown(payload: GoogleResultPayload): string {
  const lines = [
    `# ${sourceTitle(payload.source)}`,
    "",
    `**Query:** ${payload.query}`,
    "",
    payload.content.trim(),
  ];

  if (payload.note) {
    lines.push("", `> ${payload.note}`);
  }

  if (payload.refinements && payload.refinements.length > 0) {
    lines.push("", "## Follow-up Expansion");
    payload.refinements.forEach((refinement, index) => {
      const heading = payload.refinements?.length === 1 ? "" : ` ${index + 1}`;
      lines.push("", `### Prompt${heading}`, "", refinement.prompt, "", `### Expanded Answer${heading}`, "", refinement.content.trim());
      if (refinement.timedOut) {
        lines.push("", "> Follow-up response did not stabilize before timeout; returning the latest captured content.");
      }
    });
  }

  if (payload.references.length > 0) {
    lines.push("", "## References", "");
    payload.references.forEach((reference, index) => {
      lines.push(`${index + 1}. [${escapeMarkdownLinkText(reference.title)}](${reference.url})`);
    });
  }

  return lines.join("\n").trim();
}

function sourceTitle(source: GoogleSource): string {
  switch (source) {
    case "google_ai_overview":
      return "Google AI Overview";
    case "google_ai_mode":
      return "Google AI Mode";
    case "google_search_results":
      return "Google Search Results";
  }
}

function escapeMarkdownLinkText(text: string): string {
  return text.replace(/[\\[\]]/g, "\\$&");
}

export function normalizeExtractedText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line, index, lines) => lines.indexOf(line) === index)
    .join("\n")
    .trim();
}

// ─── Shared Google Session ───────────────────────────────────────────

async function ensureGooglePage(): Promise<Page> {
  // Reuse existing persistent session to keep cookies (anti-CAPTCHA)
  const existingPage = browserManager.getActivePage(GOOGLE_SESSION);
  if (existingPage) return existingPage;

  log.info("Creating persistent Google session");
  const { page } = await browserManager.createPersistentSession(GOOGLE_SESSION);
  return page;
}

async function resetGoogleSession(reason: string): Promise<void> {
  log.warn("Resetting Google session", { reason });
  await browserManager.destroySession(GOOGLE_SESSION).catch(() => {});
}

async function loadGoogleUrl(url: string, label: string): Promise<Page> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= GOOGLE_NAVIGATION_ATTEMPTS; attempt++) {
    const page = await ensureGooglePage();

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: SEARCH_TIMEOUT_MS });
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      return page;
    } catch (err) {
      lastError = err;
      log.warn("Google navigation failed", { label, attempt, error: formatError(err) });
      if (attempt < GOOGLE_NAVIGATION_ATTEMPTS) {
        await resetGoogleSession(`${label} navigation retry`);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ─── Google AI Overview ──────────────────────────────────────────────

export async function googleSearchAiOverview(args: GoogleSearchArgs): Promise<ToolResult> {
  try {
    const query = validateNonEmpty(args.query, "query");
    const recency = validateRecency(args.recency);
    const format = validateResponseFormat(args.format);
    const release = await googleMutex.acquire();

    try {
      const searchUrl = buildGoogleSearchUrl(query, recency);
      log.info("Google search", { query, recency });

      const page = await loadGoogleUrl(searchUrl, "search");
      await page.waitForTimeout(2_000);

      // Check for CAPTCHA / block page
      const captchaResult = await detectCaptcha(page);
      if (captchaResult) {
        log.warn("Google CAPTCHA detected", { url: page.url() });
        return fail(captchaResult);
      }

      // Strategy 1: Extract AI Overview / Featured Snippet from results page
      const overviewResult = await tryAiOverview(page, query, format);
      if (overviewResult) return overviewResult;

      // Keep a regular-results fallback before AI Mode navigates the shared page away.
      const fallbackResult = await trySearchResults(page, query, format);

      // Strategy 2: Open AI Mode directly (fallback if no AI Overview)
      const aiModeResult = await tryAiMode(query, recency, format);
      if (aiModeResult) return aiModeResult;

      // Strategy 3: Fallback to regular search results
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

async function tryAiMode(
  query: string,
  recency: GoogleRecency,
  format: GoogleResponseFormat,
): Promise<ToolResult | null> {
  try {
    return await runAiModeSearch(query, recency, format, { fallbackOnEmpty: true });
  } catch (err) {
    log.warn("AI Mode extraction failed, falling back", { error: formatError(err) });
    return null;
  }
}

async function tryAiOverview(
  page: Page,
  query: string,
  format: GoogleResponseFormat,
): Promise<ToolResult | null> {
  const content = await extractFirstMatch(page, [
    '[data-attrid="wa:/description"]',  // featured snippet / AI overview
    ".hgKElc",                           // featured snippet text
    ".wDYxhc",                           // AI overview section
    ".mod [data-md]",                    // markdown-based AI overview
    ".xpdopen .kno-rdesc",              // knowledge card
  ]);

  if (!content) return null;

  const references = await extractSearchReferences(page);

  return toolResponse({
    source: "google_ai_overview",
    query,
    content: truncate(content),
    references,
  }, format);
}

async function trySearchResults(
  page: Page,
  query: string,
  format: GoogleResponseFormat,
): Promise<ToolResult | null> {
  const content = await extractSearchResultsSummary(page);
  if (!content) return null;

  const references = await extractSearchReferences(page);

  return toolResponse({
    source: "google_search_results",
    query,
    content: truncate(content),
    references,
    note: "AI Overview not available for this query. Returning top search results.",
  }, format);
}

async function runAiModeSearch(
  query: string,
  recency: GoogleRecency,
  format: GoogleResponseFormat,
  options: AiModeSearchOptions = {},
): Promise<ToolResult | null> {
  log.info("Google AI Mode search", { query, recency });

  const primary = await runAiModeSearchAttempt(query, recency, format, options);
  if (!primary.retryWithoutRecency) return primary.result;

  log.warn("Retrying Google AI Mode without recency filter", { query, recency, reason: primary.retryReason });
  const retry = await runAiModeSearchAttempt(query, "any", format, options);
  if (retry.retryWithoutRecency) {
    if (options.fallbackOnEmpty) return null;
    return fail(retry.retryReason ?? "Google AI Mode returned no content.");
  }
  return retry.result;
}

async function runAiModeSearchAttempt(
  query: string,
  recency: GoogleRecency,
  format: GoogleResponseFormat,
  options: AiModeSearchOptions,
): Promise<{ result: ToolResult | null; retryWithoutRecency: boolean; retryReason?: string }> {
  const aiModeUrl = buildGoogleSearchUrl(query, recency, true);

  const page = await loadGoogleUrl(aiModeUrl, "ai_mode");

  const captchaResult = await detectCaptcha(page);
  if (captchaResult) {
    log.warn("Google CAPTCHA detected", { url: page.url() });
    return { result: fail(captchaResult), retryWithoutRecency: false };
  }

  const result = await waitForAiModeResponse(page);
  if (result.captchaMessage) return { result: fail(result.captchaMessage), retryWithoutRecency: false };
  if (result.errorMessage) {
    return {
      result: null,
      retryWithoutRecency: recency !== "any",
      retryReason: result.errorMessage,
    };
  }

  if (!result.content) {
    const reason =
      `AI Mode returned no content for: "${query}". ` +
      "Google may not support AI Mode for this query or region.";

    if (recency !== "any") {
      return { result: null, retryWithoutRecency: true, retryReason: reason };
    }
    if (options.fallbackOnEmpty) return { result: null, retryWithoutRecency: false };
    return { result: fail(reason), retryWithoutRecency: false };
  }

  const references = await extractAiModeReferences(page);
  const refinements: GoogleRefinement[] = [];
  const notes: string[] = [];

  if (result.timedOut) {
    notes.push("AI Mode response did not stabilize before timeout; returning the latest captured content.");
  }

  if (options.followUp && shouldRunAiModeFollowUp(result.content, options.followUp)) {
    const followUp = await runAiModeFollowUp(page, options.followUp, result.content);
    if (followUp.refinement) {
      refinements.push(followUp.refinement);
    }
    if (followUp.note) {
      notes.push(followUp.note);
    }
  }

  const response = toolResponse({
    source: "google_ai_mode",
    query,
    content: truncate(result.content),
    references,
    refinements: refinements.length > 0 ? refinements : undefined,
    note: notes.length > 0 ? notes.join(" ") : undefined,
  }, format);

  return { result: response, retryWithoutRecency: false };
}

async function runAiModeFollowUp(
  page: Page,
  config: AiModeFollowUpConfig,
  previousContent: string,
): Promise<{ refinement?: GoogleRefinement; note?: string }> {
  try {
    const sent = await sendAiModeFollowUp(page, config.prompt);
    if (!sent) {
      return { note: "Follow-up prompt could not be sent because the AI Mode input was not found." };
    }

    const result = await waitForAiModeResponse(page, previousContent);
    if (result.captchaMessage) return { note: result.captchaMessage };
    if (result.errorMessage) return { note: result.errorMessage };
    if (!result.content || result.content === previousContent) {
      return { note: "Follow-up prompt was sent, but no expanded AI Mode content was captured." };
    }

    return {
      refinement: {
        prompt: config.prompt,
        content: truncate(result.content),
        timedOut: result.timedOut || undefined,
      },
    };
  } catch (err) {
    return { note: `Follow-up expansion failed: ${formatError(err)}` };
  }
}

async function sendAiModeFollowUp(page: Page, prompt: string): Promise<boolean> {
  const inputSelectors = [
    'textarea[aria-label*="Ask"]',
    'textarea[placeholder*="Ask"]',
    // Thai variants of "Ask".
    'textarea[aria-label*="ถาม"]',
    'textarea[placeholder*="ถาม"]',
    'div[contenteditable="true"]',
    "textarea",
  ];

  for (const selector of inputSelectors) {
    const input = page.locator(selector).last();
    const visible = await input.isVisible({ timeout: 2_000 }).catch(() => false);
    if (!visible) continue;

    await input.click();
    const tagName = await input.evaluate((el) => el.tagName.toLowerCase()).catch(() => "div");

    if (tagName === "textarea" || tagName === "input") {
      await input.fill(prompt);
    } else {
      await page.keyboard.press("Meta+A");
      await page.keyboard.press("Backspace");
      await page.keyboard.insertText(prompt);
    }

    const sendButton = page
      .locator('button[aria-label*="Send"], button[aria-label*="ส่ง"], button[type="submit"]')
      .last();
    const hasSendButton = await sendButton.isVisible({ timeout: 1_500 }).catch(() => false);
    if (hasSendButton) {
      await sendButton.click();
    } else {
      await page.keyboard.press("Enter");
    }

    log.debug("AI Mode follow-up prompt sent", { chars: prompt.length });
    return true;
  }

  return false;
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function extractFirstMatch(page: Page, selectors: string[]): Promise<string | null> {
  return extractBestText(page, selectors);
}

async function extractBestText(
  page: Page,
  selectors: string[],
  minLength = MIN_EXTRACTED_TEXT_LENGTH,
): Promise<string | null> {
  const candidates: string[] = [];

  for (const sel of selectors) {
    try {
      const locator = page.locator(sel);
      const count = Math.min(await locator.count().catch(() => 0), 3);

      for (let index = 0; index < count; index++) {
        const text = await locator.nth(index).textContent({ timeout: 2_000 }).catch(() => null);
        const normalized = text ? normalizeExtractedText(text) : "";
        if (normalized.length >= minLength) {
          candidates.push(normalized);
        }
      }
    } catch {
      // Selector not found or timeout — try next
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0];
}

async function extractSearchResultsSummary(page: Page): Promise<string | null> {
  try {
    const results = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("#search .MjjYud, #rso > div"))
        .map((item) => {
          const title = item.querySelector("h3")?.textContent?.trim() ?? "";
          const snippet = item.querySelector(".VwiC3b, .yDYNvb, .IsZvec")?.textContent?.trim() ?? "";
          if (!title && !snippet) return "";
          return [title, snippet].filter(Boolean).join("\n");
        })
        .filter(Boolean)
        .slice(0, 6);
    });

    const content = normalizeExtractedText(results.join("\n\n"));
    if (content.length >= MIN_EXTRACTED_TEXT_LENGTH) return content;
  } catch {
    // Fall through to broad DOM fallback
  }

  return extractBestText(page, ["#rso", "#search"]);
}

function truncate(text: string): string {
  if (text.length <= MAX_CONTENT_LENGTH) return text;
  return text.substring(0, MAX_CONTENT_LENGTH) + `\n\n[truncated — ${text.length} total chars]`;
}

function cleanUrl(raw: string): string {
  // Remove Google's text highlight fragment (#:~:text=...)
  const idx = raw.indexOf("#:~:text=");
  return idx !== -1 ? raw.substring(0, idx) : raw;
}

export function normalizeReferenceUrl(raw: string): string | null {
  if (!raw || raw.startsWith("#") || raw.startsWith("javascript:")) return null;

  try {
    const parsed = new URL(raw, "https://www.google.com");
    const hostname = parsed.hostname.replace(/^www\./, "");

    if (hostname === "google.com" && parsed.pathname === "/url") {
      const target = parsed.searchParams.get("q") ?? parsed.searchParams.get("url");
      return target ? normalizeReferenceUrl(target) : null;
    }

    if (isGoogleInternalUrl(parsed)) return null;

    parsed.hash = parsed.hash.startsWith("#:~:text=") ? "" : parsed.hash;
    return cleanUrl(parsed.href);
  } catch {
    return null;
  }
}

function isGoogleInternalUrl(url: URL): boolean {
  const hostname = url.hostname.replace(/^www\./, "");
  if (!hostname.endsWith("google.com")) return false;

  if (["accounts.google.com", "policies.google.com", "support.google.com"].includes(hostname)) {
    return true;
  }

  return [
    "/search",
    "/sorry",
    "/preferences",
    "/policies",
    "/intl",
    "/setprefs",
  ].some((path) => url.pathname.startsWith(path));
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.substring(0, 60);
  }
}

/**
 * Extract reference links from AI Mode response container.
 * Collects inline links (class H23r4e) and citation links (class NDNGvf).
 */
async function extractAiModeReferences(page: Page): Promise<Reference[]> {
  try {
    const rawLinks = await extractRawLinks(page, [
      "#aim-chrome-initial-inline-async-container",
      ".Zkbeff",
      "main",
      '[role="main"]',
    ]);

    return normalizeReferences(rawLinks);
  } catch {
    return [];
  }
}

/**
 * Extract references from regular Google search results.
 * Each .yuRUbf contains a result link with title + URL.
 */
async function extractSearchReferences(page: Page): Promise<Reference[]> {
  try {
    const rawLinks: RawReference[] = await page.evaluate(() => {
      const results: { title: string; url: string }[] = [];
      document.querySelectorAll("#search a[href], #rso a[href]").forEach((anchor) => {
        const heading = anchor.querySelector("h3") ?? anchor.closest(".MjjYud, .g, .yuRUbf")?.querySelector("h3");
        if (!anchor || !heading) return;
        const href = anchor.getAttribute("href") ?? "";
        if (!href || href.startsWith("#")) return;
        results.push({
          title: (heading.textContent ?? "").trim(),
          url: href,
        });
      });
      return results;
    });

    return normalizeReferences(rawLinks);
  } catch {
    return [];
  }
}

async function extractRawLinks(page: Page, containerSelectors: string[]): Promise<RawReference[]> {
  for (const selector of containerSelectors) {
    const container = page.locator(selector).first();
    const exists = await container.count().then((count) => count > 0).catch(() => false);
    if (!exists) continue;

    const links = await container.evaluate((el: Element) => {
      return Array.from(el.querySelectorAll("a[href]"))
        .map((anchor) => ({
          title: (anchor.textContent ?? "").trim(),
          url: anchor.getAttribute("href") ?? "",
        }))
        .filter((link) => link.url.length > 0)
        .slice(0, 40);
    }).catch(() => [] as RawReference[]);

    if (links.length > 0) return links;
  }

  return [];
}

function normalizeReferences(rawLinks: RawReference[]): Reference[] {
  const seen = new Set<string>();
  const refs: Reference[] = [];

  for (const link of rawLinks) {
    const url = normalizeReferenceUrl(link.url);
    if (!url || seen.has(url)) continue;

    seen.add(url);
    refs.push({ title: normalizeReferenceTitle(link.title, url), url });
  }

  return refs.slice(0, 10);
}

function normalizeReferenceTitle(title: string, url: string): string {
  const normalized = normalizeExtractedText(title).replace(/\n/g, " ");
  return normalized.length > 0 ? normalized : extractDomain(url);
}

// ─── Google AI Mode (Direct) ─────────────────────────────────────────

const AI_MODE_TIMEOUT_MS = 60_000;
const AI_MODE_POLL_MS = 1_500;
const AI_MODE_STABLE_POLLS = 3;

export async function googleSearchAiMode(args: GoogleSearchArgs): Promise<ToolResult> {
  try {
    const query = validateNonEmpty(args.query, "query");
    const recency = validateRecency(args.recency);
    const format = validateResponseFormat(args.format);
    const followUp = validateFollowUpConfig(args);
    const release = await googleMutex.acquire();

    try {
      return await runAiModeSearch(query, recency, format, { followUp }) ?? fail(
        `AI Mode returned no content for: "${query}". ` +
        "Google may not support AI Mode for this query or region.",
      );
    } finally {
      release();
    }
  } catch (err) {
    if (err instanceof ValidationError) return fail(err.message);
    return fail(`google_search_ai_mode: ${formatError(err)}`);
  }
}

async function waitForAiModeResponse(page: Page, previousContent?: string): Promise<AiModeWaitResult> {
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
    if (captcha) return { content: null, captchaMessage: captcha, timedOut: false };

    const text = await extractBestText(page, selectors);
    if (!text) continue;
    if (previousContent && text === previousContent) continue;

    const errorMessage = detectAiModeErrorText(text);
    if (errorMessage) return { content: null, errorMessage, timedOut: false };

    if (text === lastText) {
      stableCount++;
      if (stableCount >= AI_MODE_STABLE_POLLS) {
        log.debug("AI Mode response stabilized", { chars: text.length });
        return { content: text, timedOut: false };
      }
    } else {
      stableCount = 0;
      lastText = text;
    }
  }

  // Timeout — return whatever we collected
  if (lastText.length >= MIN_EXTRACTED_TEXT_LENGTH) {
    log.warn("AI Mode response timed out before stabilizing", { chars: lastText.length });
    return { content: lastText, timedOut: true };
  }

  return { content: null, timedOut: true };
}

// ─── Tool Schema ─────────────────────────────────────────────────────

export const googleToolDefinitions = [
  {
    name: "google_search_ai_overview",
    description:
      "PRIMARY search tool. Search Google and extract the AI Overview summary for a given query. " +
      "Tries AI Overview first, then AI Mode, then top search results as fallback. " +
      "Use this as the default search tool for most queries. " +
      "Returns Markdown by default, or structured JSON when format=json. Default: results from past month.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "The search query (non-empty string)" },
        recency: {
          type: "string",
          enum: ["day", "week", "month", "year", "any"],
          description: "Filter results by recency. Default: 'month'. Use 'any' for all-time results.",
        },
        format: {
          type: "string",
          enum: ["markdown", "json"],
          description: "Response format. Default: 'markdown'. Use 'json' for structured parsing.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "google_search_ai_mode",
    description:
      "Search Google using AI Mode directly (udm=50). Goes straight to Google's AI-generated answer " +
      "instead of regular search results. The response streams in and is captured once stable. " +
      "Use when you specifically need AI Mode's deeper synthesis (e.g. complex multi-step questions). " +
      "For most queries, prefer google_search_ai_overview instead. " +
      "Returns Markdown by default, or structured JSON when format=json. Default: results from past month.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "The search query (non-empty string)" },
        recency: {
          type: "string",
          enum: ["day", "week", "month", "year", "any"],
          description: "Filter results by recency. Default: 'month'. Use 'any' for all-time results.",
        },
        format: {
          type: "string",
          enum: ["markdown", "json"],
          description: "Response format. Default: 'markdown'. Use 'json' for structured parsing.",
        },
        followUpPrompt: {
          type: "string",
          description: "Optional prompt to send after the first AI Mode answer when you want a more detailed or corrected response.",
        },
        followUpMode: {
          type: "string",
          enum: ["always", "if_short"],
          description: "When to send followUpPrompt. Default: 'always'. Use 'if_short' to send only when the first answer is shorter than minContentLength.",
        },
        minContentLength: {
          type: "number",
          description:
            "Minimum first-answer length used by followUpMode='if_short' (default: 1200; capped by the internal maximum limit).",
        },
      },
      required: ["query"],
    },
  },
];
