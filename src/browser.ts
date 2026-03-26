import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";
import { log, Mutex } from "./shared.js";

// ─── Configuration ───────────────────────────────────────────────────

const EPHEMERAL_TIMEOUT_MS = Number(process.env.SESSION_TTL_MS) || 120_000;
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS) || 10;
const PROFILE_DIR = process.env.CHROME_PROFILE_DIR
  ?? join(homedir(), ".chome-bot-mcp", "chrome-profile");

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
  private sessions = new Map<string, Session>();
  private cleanupTimer: Timer | null = null;
  private headless: boolean;
  private shuttingDown = false;

  // Mutexes to prevent concurrent browser/session creation races
  private browserMutex = new Mutex();
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
        log.warn("Browser disconnected unexpectedly");
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

      // Ensure profile directory exists
      mkdirSync(PROFILE_DIR, { recursive: true });

      log.info("Launching persistent session", { id, profileDir: PROFILE_DIR });
      const context = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: this.headless,
        channel: "chrome",
        args: launchArgs(),
        ...contextOptions(),
      });
      await context.addInitScript(STEALTH_SCRIPTS);

      const page = context.pages()[0] ?? await context.newPage();
      this.installPageGuards(page, id);

      const now = Date.now();
      this.sessions.set(id, { context, page, createdAt: now, lastUsedAt: now, persistent: true });
      log.debug("Persistent session created", { id });
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
      log.debug("Page closed", { sessionId });
    });
  }

  private startCleanupLoop(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.reapStale(), 15_000);
  }

  private async reapStale(): Promise<void> {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.persistent) continue;

      const expired = now - session.lastUsedAt > EPHEMERAL_TIMEOUT_MS;
      const dead = !this.isPageAlive(session.page);

      if (expired || dead) {
        log.debug("Reaping session", { id, expired, dead });
        await this.destroySessionInternal(id);
      }
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
