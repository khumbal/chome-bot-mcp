import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { toolDefinitions, dispatchTool } from "./tools.js";
import { googleToolDefinitions, googleSearchAiOverview } from "./google.js";
import {
  geminiToolDefinitions,
  geminiChat,
  geminiNewChat,
  geminiSummarizeYoutube,
} from "./gemini.js";
import { browserManager } from "./browser.js";

// Configure headless mode via env (default: false — Google blocks headless Chrome)
const headless = process.env.HEADLESS === "true";
browserManager.setHeadless(headless);

const server = new Server(
  { name: "vinyan-chrome-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...toolDefinitions, ...googleToolDefinitions, ...geminiToolDefinitions],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  // High-level tools
  switch (name) {
    case "google_search_ai_overview":
      return googleSearchAiOverview(a as { query: string });
    case "gemini_chat":
      return geminiChat(a as { message: string });
    case "gemini_new_chat":
      return geminiNewChat();
    case "gemini_summarize_youtube":
      return geminiSummarizeYoutube(a as { youtubeUrl: string });
  }

  // Low-level browser tools
  return dispatchTool(name, a);
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[vinyan-chrome-mcp] MCP server running on stdio (headless=${headless})`);
}

process.on("SIGINT", async () => {
  console.error("[vinyan-chrome-mcp] Shutting down…");
  await browserManager.shutdown();
  await server.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await browserManager.shutdown();
  await server.close();
  process.exit(0);
});

main().catch((err) => {
  console.error("[vinyan-chrome-mcp] Fatal:", err);
  process.exit(1);
});
