/**
 * E2E test — Google AI Mode (direct via udm=50)
 * Uses persistent Chrome profile to maintain cookies & avoid CAPTCHA.
 * If CAPTCHA is detected, waits for manual resolution before retrying.
 * Run: bun run test/e2e-google-ai-mode.ts
 */
import { browserManager } from "../src/browser.js";
import { googleSearchAiMode } from "../src/google.js";

browserManager.setHeadless(false);

async function run() {
  console.log("=== Google AI Mode (Direct) Test ===\n");

  let result = await googleSearchAiMode({ query: "what is MCP model context protocol" });

  // If CAPTCHA, wait for manual solve then retry
  if (result.isError && result.content[0].text.includes("CAPTCHA")) {
    console.log("\n⚠️  CAPTCHA detected! Please solve it in the browser window...");
    console.log("   Waiting 30 seconds for manual CAPTCHA resolution...\n");

    // Wait for user to solve CAPTCHA manually
    await new Promise((resolve) => setTimeout(resolve, 30_000));

    console.log("Retrying search...\n");
    result = await googleSearchAiMode({ query: "what is MCP model context protocol" });
  }

  console.log("isError:", result.isError ?? false);
  console.log("\nResponse:");
  console.log(result.content[0].text.substring(0, 3000));

  await browserManager.shutdown();
  console.log("\nDone!");
}

run().catch((err) => {
  console.error("Test failed:", err);
  browserManager.shutdown().then(() => process.exit(1));
});
