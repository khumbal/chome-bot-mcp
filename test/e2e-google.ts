/**
 * E2E smoke test — Google Search → extract AI Overview
 * Run: bun run test/e2e-google.ts
 */
import { browserManager } from "../src/browser.js";
import {
  browserNavigate,
  browserFill,
  browserPressKey,
  browserWait,
  browserExtractText,
  browserGetDomState,
  browserScreenshot,
  browserCloseSession,
} from "../src/tools.js";

const SESSION = "test-google";

// Use headful mode for Google (headless gets CAPTCHA'd)
browserManager.setHeadless(false);

async function run() {
  console.log("=== Step 1: Navigate to Google ===");
  const nav = await browserNavigate({ url: "https://www.google.com", sessionId: SESSION });
  console.log(nav.content[0].text);
  if (nav.isError) throw new Error("Navigation failed");

  console.log("\n=== Step 2: Fill search box ===");
  const fill = await browserFill({
    selector: 'textarea[name="q"]',
    text: "what is MCP model context protocol",
    sessionId: SESSION,
  });
  console.log(fill.content[0].text);

  console.log("\n=== Step 3: Submit search ===");
  const press = await browserPressKey({ key: "Enter", sessionId: SESSION });
  console.log(press.content[0].text);

  console.log("\n=== Step 4: Wait for results to load ===");
  const wait = await browserWait({ milliseconds: 5000, sessionId: SESSION });
  console.log(wait.content[0].text);

  console.log("\n=== Step 5: Screenshot search results ===");
  const shot = await browserScreenshot({ sessionId: SESSION });
  console.log(shot.content[0].text);

  // Save screenshot to file for inspection
  const session = browserManager.getSession(SESSION);
  if (session) {
    await session.page.screenshot({ path: "screenshots/results.png", fullPage: false });
    console.log("Screenshot saved to screenshots/results.png");
  }

  console.log("\n=== Step 6: Get DOM state ===");
  const state = await browserGetDomState({ sessionId: SESSION });
  const stateText = state.content[0].text;
  console.log(stateText.substring(0, 3000));
  console.log(`\n... (total ${stateText.length} chars)`);

  console.log("\n=== Step 7: Try to extract AI Overview / search results ===");
  // Try various selectors for Google AI Overview & search results
  const extractionTargets = [
    { name: "AI Overview", selector: ".wDYxhc" },
    { name: "AI Overview (alt)", selector: '[data-attrid="wa:/description"]' },
    { name: "Featured Snippet", selector: ".hgKElc" },
    { name: "Search Results Area", selector: "#rso" },
    { name: "Knowledge Panel", selector: ".kno-rdesc" },
  ];

  for (const target of extractionTargets) {
    const result = await browserExtractText({ selector: target.selector, sessionId: SESSION });
    if (!result.isError && !result.content[0].text.includes("contains no text")) {
      console.log(`\n✓ Found: ${target.name} (${target.selector})`);
      console.log(result.content[0].text.substring(0, 800));
      console.log("---");
    }
  }

  console.log("\n=== Step 8: Cleanup ===");
  const close = await browserCloseSession({ sessionId: SESSION });
  console.log(close.content[0].text);

  await browserManager.shutdown();
  console.log("\nDone!");
}

run().catch((err) => {
  console.error("Test failed:", err);
  browserManager.shutdown().then(() => process.exit(1));
});
