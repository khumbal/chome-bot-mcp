import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { toolDefinitions, dispatchTool } from "./tools.js";
import { googleToolDefinitions, googleSearchAiOverview, googleSearchAiMode } from "./google.js";
import {
  geminiToolDefinitions,
  geminiChat,
  geminiNewChat,
  geminiSummarizeYoutube,
} from "./gemini.js";
import {
  searchToolDefinitions,
  webFetchContent,
  duckduckgoSearch,
  newsSearch,
  wikipediaSearch,
} from "./search.js";
import { browserManager } from "./browser.js";
import { log, fail } from "./shared.js";

// ─── Configuration ───────────────────────────────────────────────────

const headless = process.env.HEADLESS === "true";
browserManager.setHeadless(headless);

const SHUTDOWN_TIMEOUT_MS = 10_000;

// ─── Server ──────────────────────────────────────────────────────────

const server = new Server(
  { name: "chrome-bot-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...toolDefinitions, ...googleToolDefinitions, ...geminiToolDefinitions, ...searchToolDefinitions],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case "google_search_ai_overview":
        return googleSearchAiOverview(a as { query: string });
      case "google_search_ai_mode":
        return googleSearchAiMode(a as { query: string });
      case "gemini_chat":
        return geminiChat(a as { message: string });
      case "gemini_new_chat":
        return geminiNewChat();
      case "gemini_summarize_youtube":
        return geminiSummarizeYoutube(a as { youtubeUrl: string });
      case "web_fetch_content":
        return webFetchContent(a as { url: string; selector?: string });
      case "duckduckgo_search":
        return duckduckgoSearch(a as { query: string; maxResults?: number });
      case "news_search":
        return newsSearch(a as { query: string; maxResults?: number });
      case "wikipedia_search":
        return wikipediaSearch(a as { query: string; language?: string });
      default:
        return dispatchTool(name, a);
    }
  } catch (err) {
    log.error("Unhandled tool error", { tool: name, error: String(err) });
    return fail(`Internal error in tool "${name}". Check server logs.`);
  }
});

// ─── Graceful Shutdown ───────────────────────────────────────────────

let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.info("Shutdown initiated", { signal });

  // Force exit after timeout to prevent hanging
  const forceTimer = setTimeout(() => {
    log.error("Graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    await browserManager.shutdown();
    await server.close();
  } catch (err) {
    log.error("Error during shutdown", { error: String(err) });
  } finally {
    clearTimeout(forceTimer);
    process.exit(0);
  }
}

// ─── Process Event Handlers ──────────────────────────────────────────

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  log.error("Unhandled promise rejection", { reason: String(reason) });
});

process.on("uncaughtException", (err) => {
  log.error("Uncaught exception", { error: err.message, stack: err.stack });
  gracefulShutdown("uncaughtException");
});

// ─── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log.info("MCP server started", {
    headless,
    maxSessions: process.env.MAX_SESSIONS || "10",
    logLevel: process.env.LOG_LEVEL || "info",
  });
}

main().catch((err) => {
  log.error("Fatal startup error", { error: String(err) });
  process.exit(1);
});
