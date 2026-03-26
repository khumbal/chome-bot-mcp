/**
 * Debug — inspect Google AI Mode page DOM to find correct selectors
 * Run: bun run test/debug-ai-mode.ts
 */
import { browserManager } from "../src/browser.js";

browserManager.setHeadless(false);

async function run() {
  console.log("=== Debug Google AI Mode DOM ===\n");

  const { page } = await browserManager.createSession("debug");
  const query = "what is MCP model context protocol";
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=50&hl=en`;

  console.log("Navigating to:", url);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // Wait for streaming content
  console.log("Waiting 15s for AI Mode to stream response...");
  await page.waitForTimeout(15_000);

  console.log("\n--- Current URL ---");
  console.log(page.url());

  console.log("\n--- Page Title ---");
  console.log(await page.title());

  // Try various selectors to see what exists
  const selectors = [
    ".XbIp4e",
    ".wDYxhc",
    "[data-md]",
    ".LDSMQd",
    ".xpdopen .kno-rdesc",
    "#rso",
    "#search",
    ".kp-wholepage",
    "[data-attrid]",
    ".mod",
    "[jsname]",
    ".aimode-response",
    "[data-hveid]",
    "main",
    "[role='main']",
    ".M8OgIe",     // AI mode area
    ".EyBRub",     // AI response text
    ".yDYNvb",     // snippet text
    ".WaaZC",
    ".VwiC3b",     // result description
    ".r21Kzd",     // AI mode response
    ".Ap5OSd",     // knowledge panel text
  ];

  console.log("\n--- Selector Match Scan ---");
  for (const sel of selectors) {
    const count = await page.locator(sel).count().catch(() => 0);
    if (count > 0) {
      const text = await page.locator(sel).first().textContent({ timeout: 2_000 }).catch(() => "(error)");
      const preview = (text ?? "").trim().substring(0, 120);
      console.log(`✅ ${sel} — ${count} match(es) — "${preview}..."`);
    }
  }

  // Dump body aria snapshot for overview
  console.log("\n--- Accessibility Snapshot (first 3000 chars) ---");
  const snapshot = await page.locator("body").ariaSnapshot().catch(() => "unavailable");
  console.log(snapshot.substring(0, 3000));

  // Screenshot
  const buf = await page.screenshot({ fullPage: true, type: "png" });
  const path = "screenshots/debug-ai-mode.png";
  await Bun.write(path, buf);
  console.log(`\nScreenshot saved: ${path}`);

  await browserManager.shutdown();
  console.log("\nDone!");
}

run().catch((err) => {
  console.error("Debug failed:", err);
  browserManager.shutdown().then(() => process.exit(1));
});
