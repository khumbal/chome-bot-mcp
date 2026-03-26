import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { join } from "path";
import { homedir } from "os";

const CONTEXT_TIMEOUT_MS = 120_000;
const PROFILE_DIR = join(homedir(), ".vinyan-chrome-mcp", "chrome-profile");

interface Session {
  context: BrowserContext;
  page: Page;
  createdAt: number;
  persistent: boolean;
}

const STEALTH_SCRIPTS = `
  // Hide webdriver flag
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

  // Realistic plugins array
  Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3, 4, 5],
  });

  // Realistic languages
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en', 'th'],
  });

  // Chrome runtime stub
  if (!window.chrome) {
    window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
  }

  // Permissions query override
  const originalQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
  if (originalQuery) {
    window.navigator.permissions.query = (params) =>
      params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(params);
  }
`;

class BrowserManager {
  private browser: Browser | null = null;
  private sessions = new Map<string, Session>();
  private cleanupTimer: Timer | null = null;
  private headless: boolean;

  constructor(headless = true) {
    this.headless = headless;
  }

  setHeadless(value: boolean): void {
    this.headless = value;
  }

  async ensureBrowser(): Promise<Browser> {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await chromium.launch({
        headless: this.headless,
        channel: "chrome", // use real Chrome instead of headless shell
        args: [
          "--disable-blink-features=AutomationControlled",
          "--disable-features=IsolateOrigins,site-per-process",
          "--no-first-run",
          "--no-default-browser-check",
        ],
      });
      this.startCleanupLoop();
    }
    return this.browser;
  }

  async createSession(id: string): Promise<{ context: BrowserContext; page: Page }> {
    await this.destroySession(id);

    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
      timezoneId: "Asia/Bangkok",
      javaScriptEnabled: true,
    });

    // Inject stealth patches before any page navigation
    await context.addInitScript(STEALTH_SCRIPTS);

    const page = await context.newPage();

    this.sessions.set(id, { context, page, createdAt: Date.now(), persistent: false });
    return { context, page };
  }

  /**
   * Create a persistent session backed by a real Chrome profile directory.
   * This preserves cookies/login across restarts — required for Gemini.
   */
  async createPersistentSession(id: string): Promise<{ context: BrowserContext; page: Page }> {
    const existing = this.sessions.get(id);
    if (existing) return { context: existing.context, page: existing.page };

    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: this.headless,
      channel: "chrome",
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
      ],
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
      timezoneId: "Asia/Bangkok",
    });

    await context.addInitScript(STEALTH_SCRIPTS);

    // Use existing page or create new
    const page = context.pages()[0] ?? await context.newPage();

    this.sessions.set(id, { context, page, createdAt: Date.now(), persistent: true });
    return { context, page };
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  async destroySession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session) {
      await session.context.close().catch(() => {});
      this.sessions.delete(id);
    }
  }

  private startCleanupLoop(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.reapStale(), 15_000);
  }

  private async reapStale(): Promise<void> {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (!session.persistent && now - session.createdAt > CONTEXT_TIMEOUT_MS) {
        await this.destroySession(id);
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const id of this.sessions.keys()) {
      await this.destroySession(id);
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}

export const browserManager = new BrowserManager();
