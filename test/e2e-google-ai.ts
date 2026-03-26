/**
 * E2E test — Google AI Overview extraction
 * Run: bun run test/e2e-google-ai.ts
 */
import { browserManager } from "../src/browser.js";
import { googleSearchAiOverview } from "../src/google.js";

browserManager.setHeadless(false);

async function run() {
  console.log("=== Google AI Overview Test ===\n");

  const result = await googleSearchAiOverview({ query: "what is MCP model context protocol" });

  console.log("isError:", result.isError ?? false);
  console.log("\nResponse:");
  console.log(result.content[0].text.substring(0, 2000));

  await browserManager.shutdown();
  console.log("\nDone!");
}

run().catch((err) => {
  console.error("Test failed:", err);
  browserManager.shutdown().then(() => process.exit(1));
});
