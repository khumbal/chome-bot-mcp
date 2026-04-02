import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";
import { log, Mutex } from "./shared.js";

// ─── Configuration ───────────────────────────────────────────────────

const EPHEMERAL_TIMEOUT_MS = Number(process.env.SESSION_TTL_MS) || 120_000;
const PERSISTENT_TIMEOUT_MS = Number(process.env.PERSISTENT_SESSION_TTL_MS) || 10 * 60_000;
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS) || 10;
const PROFILE_DIR = process.env.CHROME_PROFILE_DIR
  ?? join(homedir(), ".chrome-bot-mcp", "chrome-profile");

// ─── Stealth Scripts ─────────────────────────────────────────────────

const STEALTH_SCRIPTS = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'th'] });
  if (!window.chrome) {
    window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
  }
  const origQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
  if (origQuery) {
    window.navigator.permissions.query = (p) =>
      p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : origQuery(p);
  }
`;

// ─── Types ───────────────────────────────────────────────────────────

interface Session {
  context: BrowserContext;
  page: Page;
  createdAt: number;
  lastUsedAt: number;
  persistent: boolean;
}

// ─── Cookie Consent Auto-Dismiss ─────────────────────────────────────

const COOKIE_SELECTORS = [
  "#onetrust-accept-btn-handler",
  '[data-testid="cookie-accept"]',
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
  ".fc-cta-consent",
  ".cc-accept",
  ".cc-btn.cc-allow",
];

const COOKIE_TEXT_PATTERNS = [
  "Accept all",
  "Accept cookies",
  "Allow all",
  "Allow cookies",
  "I agree",
  "Agree",
  "OK",
];

export async function dismissCookieConsent(page: Page): Promise<void> {
  try {
    // Try CSS selectors first (faster)
    for (const sel of COOKIE_SELECTORS) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
        await el.click({ timeout: 1_000 }).catch(() => {});
        log.debug("Cookie consent dismissed via selector", { selector: sel });
        return;
      }
    }
    // Try text-based button matching
    for (const text of COOKIE_TEXT_PATTERNS) {
      const btn = page.locator(`button:has-text("${text}"), a:has-text("${text}")`).first();
      if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
        await btn.click({ timeout: 1_000 }).catch(() => {});
        log.debug("Cookie consent dismissed via text", { text });
        return;
      }
    }
  } catch {
    // Best-effort — never fail
  }
}

// ─── Page Content Cache ──────────────────────────────────────────────

const PAGE_CACHE_TTL_MS = Number(process.env.PAGE_CACHE_TTL_MS) || 5 * 60_000;
const PAGE_CACHE_MAX_ENTRIES = 50;

export interface CachedPage {
  content: string;
  title: string;
  author?: string;
  date?: string;
  siteName?: string;
  wordCount: number;
  fetchedAt: number;
}

export class PageCache {
  private cache = new Map<string, CachedPage>();

  private normalizeUrl(url: string): string {
    try {
      const u = new URL(url);
      u.hash = "";
      u.hostname = u.hostname.toLowerCase();
      return u.href;
    } catch {
      return url;
    }
  }

  get(url: string): CachedPage | undefined {
    const key = this.normalizeUrl(url);
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.fetchedAt > PAGE_CACHE_TTL_MS) {
      this.cache.delete(key);
      return undefined;
    }
    // Move to end (LRU)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry;
  }

  set(url: string, data: Omit<CachedPage, "fetchedAt">): void {
    const key = this.normalizeUrl(url);
    // Evict oldest if at capacity
    if (this.cache.size >= PAGE_CACHE_MAX_ENTRIES && !this.cache.has(key)) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(key, { ...data, fetchedAt: Date.now() });
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

export const pageCache = new PageCache();

// ─── Browser Launch Options ──────────────────────────────────────────

function launchArgs(): string[] {
  return [
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
    "--no-first-run",
    "--no-default-browser-check",
  ];
}

function contextOptions() {
  return {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 } as const,
    locale: "en-US",
    timezoneId: "Asia/Bangkok",
    javaScriptEnabled: true,
  };
}

// ─── BrowserManager ──────────────────────────────────────────────────

class BrowserManager {
  private browser: Browser | null = null;
  private persistentContext: BrowserContext | null = null;
  private sessions = new Map<string, Session>();
  private cleanupTimer: Timer | null = null;
  private headless: boolean;
  private shuttingDown = false;

  // Mutexes to prevent concurrent browser/session creation races
  private browserMutex = new Mutex();
  private persistentContextMutex = new Mutex();
  private sessionMutexes = new Map<string, Mutex>();

  constructor(headless = true) {
    this.headless = headless;
  }

  setHeadless(value: boolean): void {
    this.headless = value;
  }

  // ─── Browser Lifecycle ───────────────────────────────────────────

  async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;

    const release = await this.browserMutex.acquire();
    try {
      // Double-check after acquiring lock
      if (this.browser?.isConnected()) return this.browser;

      log.info("Launching browser", { headless: this.headless });
      this.browser = await chromium.launch({
        headless: this.headless,
        channel: "chrome",
        args: launchArgs(),
      });

      // Handle unexpected browser disconnection
      this.browser.on("disconnected", () => {
        if (this.shuttingDown) {
          log.info("Shared browser disconnected during shutdown");
        } else {
          log.warn("Shared browser disconnected unexpectedly");
        }
        this.browser = null;
        // Remove all non-persistent sessions (collect IDs first to avoid delete-during-iterate)
        const toRemove = Array.from(this.sessions.entries())
          .filter(([, s]) => !s.persistent)
          .map(([id]) => id);
        for (const id of toRemove) {
          this.sessions.delete(id);
        }
      });

      this.startCleanupLoop();
      return this.browser;
    } finally {
      release();
    }
  }

  // ─── Ephemeral Sessions ──────────────────────────────────────────

  async createSession(id: string): Promise<{ context: BrowserContext; page: Page }> {
    this.guardShutdown();
    this.guardMaxSessions(id);
    const release = await this.getSessionMutex(id).acquire();

    try {
      await this.destroySessionInternal(id);

      const browser = await this.ensureBrowser();
      const context = await browser.newContext(contextOptions());
      await context.addInitScript(STEALTH_SCRIPTS);

      const page = await context.newPage();
      this.installPageGuards(page, id);

      const now = Date.now();
      this.sessions.set(id, { context, page, createdAt: now, lastUsedAt: now, persistent: false });
      log.debug("Session created", { id, total: this.sessions.size });
      return { context, page };
    } finally {
      release();
    }
  }

  // ─── Persistent Sessions (Gemini) ────────────────────────────────

  async createPersistentSession(id: string): Promise<{ context: BrowserContext; page: Page }> {
    this.guardShutdown();
    const release = await this.getSessionMutex(id).acquire();

    try {
      // Return existing if alive
      const existing = this.sessions.get(id);
      if (existing && this.isPageAlive(existing.page)) {
        existing.lastUsedAt = Date.now();
        return { context: existing.context, page: existing.page };
      }

      // Clean up dead session if present
      if (existing) {
        await this.destroySessionInternal(id);
      }

      const context = await this.ensurePersistentContext();
      const page = this.countPersistentSessions() === 0
        ? (context.pages()[0] ?? await context.newPage())
        : await context.newPage();
      this.installPageGuards(page, id);

      const now = Date.now();
      this.sessions.set(id, { context, page, createdAt: now, lastUsedAt: now, persistent: true });
      log.info("Persistent session ready", { id, totalPersistentSessions: this.countPersistentSessions() });
      return { context, page };
    } finally {
      release();
    }
  }

  // ─── Session Access ──────────────────────────────────────────────

  getSession(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (session) {
      session.lastUsedAt = Date.now();
    }
    return session;
  }

  /**
   * Get session's page — returns null if session doesn't exist or page is dead.
   */
  getActivePage(id: string): Page | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (!this.isPageAlive(session.page)) {
      log.warn("Page is dead, cleaning up session", { id });
      this.destroySessionInternal(id).catch(() => {});
      return null;
    }
    session.lastUsedAt = Date.now();
    return session.page;
  }

  listSessions(): Array<{ id: string; persistent: boolean; ageMs: number; url: string }> {
    const now = Date.now();
    return Array.from(this.sessions.entries()).map(([id, s]) => ({
      id,
      persistent: s.persistent,
      ageMs: now - s.createdAt,
      url: this.isPageAlive(s.page) ? s.page.url() : "(dead)",
    }));
  }

  // ─── Session Destruction ─────────────────────────────────────────

  async destroySession(id: string): Promise<void> {
    const release = await this.getSessionMutex(id).acquire();
    try {
      await this.destroySessionInternal(id);
    } finally {
      release();
    }
  }

  private async destroySessionInternal(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;

    log.debug("Destroying session", { id, persistent: session.persistent });
    if (session.persistent) {
      this.sessions.delete(id);
      try {
        if (!session.page.isClosed()) {
          await session.page.close();
        }
      } catch {
        // Already closed — ignore
      }

      if (this.countPersistentSessions() === 0) {
        await this.closePersistentContext();
      }
      return;
    }

    try {
      await session.context.close();
    } catch {
      // Already closed — ignore
    }
    this.sessions.delete(id);
  }

  // ─── Shutdown ────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    log.info("Shutting down browser manager");

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // Close all sessions in parallel
    const destroyPromises = Array.from(this.sessions.keys()).map((id) =>
      this.destroySessionInternal(id),
    );
    await Promise.allSettled(destroyPromises);

    await this.closePersistentContext();

    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // Already closed
      }
      this.browser = null;
    }

    log.info("Browser manager shut down");
  }

  // ─── Internals ───────────────────────────────────────────────────

  private isPageAlive(page: Page): boolean {
    try {
      return !page.isClosed();
    } catch {
      return false;
    }
  }

  private installPageGuards(page: Page, sessionId: string): void {
    page.on("crash", () => {
      log.error("Page crashed", { sessionId });
      this.sessions.delete(sessionId);
    });
    page.on("close", () => {
      const current = this.sessions.get(sessionId);
      if (current?.page === page) {
        this.sessions.delete(sessionId);
      }
      log.debug("Page closed", { sessionId });
    });
  }

  private async ensurePersistentContext(): Promise<BrowserContext> {
    if (this.persistentContext) return this.persistentContext;

    const release = await this.persistentContextMutex.acquire();
    try {
      if (this.persistentContext) return this.persistentContext;

      mkdirSync(PROFILE_DIR, { recursive: true });

      log.info("Launching shared persistent browser context", {
        profileDir: PROFILE_DIR,
        headless: this.headless,
      });

      const context = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: this.headless,
        channel: "chrome",
        args: launchArgs(),
        ...contextOptions(),
      });
      await context.addInitScript(STEALTH_SCRIPTS);

      context.on("close", () => {
        if (this.shuttingDown) {
          log.info("Persistent browser context closed during shutdown");
        } else {
          log.warn("Persistent browser context closed unexpectedly");
        }
        this.persistentContext = null;
        const toRemove = Array.from(this.sessions.entries())
          .filter(([, session]) => session.persistent)
          .map(([id]) => id);
        for (const id of toRemove) {
          this.sessions.delete(id);
        }
      });

      this.persistentContext = context;
      this.startCleanupLoop();
      return context;
    } finally {
      release();
    }
  }

  private async closePersistentContext(): Promise<void> {
    if (!this.persistentContext) return;

    const context = this.persistentContext;
    this.persistentContext = null;

    try {
      await context.close();
    } catch {
      // Already closed — ignore
    }
  }

  private countPersistentSessions(): number {
    return Array.from(this.sessions.values()).filter((session) => session.persistent).length;
  }

  private startCleanupLoop(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.reapStale(), 15_000);
  }

  private async reapStale(): Promise<void> {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      const timeout = session.persistent ? PERSISTENT_TIMEOUT_MS : EPHEMERAL_TIMEOUT_MS;
      const expired = now - session.lastUsedAt > timeout;
      const dead = !this.isPageAlive(session.page);

      if (expired || dead) {
        log.debug("Reaping session", { id, expired, dead, persistent: session.persistent });
        await this.destroySessionInternal(id);
      }
    }

    // Auto-close browser when no sessions remain
    if (this.sessions.size === 0 && this.browser) {
      log.debug("No active sessions — closing browser");
      if (this.cleanupTimer) {
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = null;
      }
      try {
        await this.browser.close();
      } catch {
        // Already closed
      }
      this.browser = null;
    }
  }

  private guardShutdown(): void {
    if (this.shuttingDown) {
      throw new Error("Browser manager is shutting down. No new sessions.");
    }
  }

  private guardMaxSessions(excludeId?: string): void {
    const activeCount = Array.from(this.sessions.entries())
      .filter(([id]) => id !== excludeId)
      .length;
    if (activeCount >= MAX_SESSIONS) {
      throw new Error(
        `Max sessions (${MAX_SESSIONS}) reached. Close existing sessions before creating new ones.`,
      );
    }
  }

  private getSessionMutex(id: string): Mutex {
    let mutex = this.sessionMutexes.get(id);
    if (!mutex) {
      mutex = new Mutex();
      this.sessionMutexes.set(id, mutex);
    }
    return mutex;
  }
}

export const browserManager = new BrowserManager();
