import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { toolDefinitions, dispatchTool } from "./tools.js";
import { googleToolDefinitions, googleSearchAiOverview, googleSearchAiMode, type GoogleSearchArgs } from "./google.js";
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
  research,
} from "./search.js";
import { browserManager } from "./browser.js";
import { type ToolResult, log, fail } from "./shared.js";

// ─── Configuration ───────────────────────────────────────────────────

const headless = process.env.HEADLESS === "true";
const ephemeralHeadless = process.env.EPHEMERAL_HEADLESS !== "false"; // default true
browserManager.setHeadless(headless);
browserManager.setEphemeralHeadless(ephemeralHeadless);

const SHUTDOWN_TIMEOUT_MS = 10_000;

type ToolArgs = Record<string, unknown>;
type ToolHandler = (args: ToolArgs) => Promise<ToolResult>;

const allToolDefinitions = [
  ...toolDefinitions,
  ...googleToolDefinitions,
  ...geminiToolDefinitions,
  ...searchToolDefinitions,
];

const directToolHandlers: Record<string, ToolHandler> = {
  google_search_ai_overview: (args) => googleSearchAiOverview(args as GoogleSearchArgs),
  google_search_ai_mode: (args) => googleSearchAiMode(args as GoogleSearchArgs),
  gemini_chat: (args) => geminiChat(args as Parameters<typeof geminiChat>[0]),
  gemini_new_chat: () => geminiNewChat(),
  gemini_summarize_youtube: (args) => geminiSummarizeYoutube(args as Parameters<typeof geminiSummarizeYoutube>[0]),
  web_fetch_content: (args) => webFetchContent(args as Parameters<typeof webFetchContent>[0]),
  duckduckgo_search: (args) => duckduckgoSearch(args as Parameters<typeof duckduckgoSearch>[0]),
  news_search: (args) => newsSearch(args as Parameters<typeof newsSearch>[0]),
  wikipedia_search: (args) => wikipediaSearch(args as Parameters<typeof wikipediaSearch>[0]),
  research: (args) => research(args as Parameters<typeof research>[0]),
};

function assertUniqueToolNames(definitions: readonly { name: string }[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const definition of definitions) {
    if (seen.has(definition.name)) {
      duplicates.add(definition.name);
      continue;
    }
    seen.add(definition.name);
  }

  if (duplicates.size > 0) {
    throw new Error(`Duplicate MCP tool names: ${Array.from(duplicates).join(", ")}`);
  }
}

async function dispatchMcpTool(name: string, args: ToolArgs): Promise<ToolResult> {
  const handler = directToolHandlers[name];
  if (handler) return handler(args);
  return dispatchTool(name, args);
}

// ─── Server ──────────────────────────────────────────────────────────

const server = new Server(
  { name: "chrome-bot-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: allToolDefinitions,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    return dispatchMcpTool(name, a);
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
  assertUniqueToolNames(allToolDefinitions);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log.info("MCP server started", {
    headless,
    ephemeralHeadless,
    maxSessions: process.env.MAX_SESSIONS || "10",
    logLevel: process.env.LOG_LEVEL || "info",
    tools: allToolDefinitions.length,
  });
}

main().catch((err) => {
  log.error("Fatal startup error", { error: String(err) });
  process.exit(1);
});
