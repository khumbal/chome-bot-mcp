/**
 * Debug — inspect Google AI Mode page DOM to find correct selectors
 * Run: bun run test/debug-ai-mode.ts
 */
import { browserManager } from "../src/browser.js";

browserManager.setHeadless(false);

async function run() {
  console.log("=== Debug Google AI Mode DOM ===\n");

  // Use persistent session to keep cookies and avoid CAPTCHA
  const { page } = await browserManager.createPersistentSession("google");
  const query = "what is MCP model context protocol";
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=50&hl=en`;

  console.log("Navigating to:", url);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // Wait for streaming content
  console.log("Waiting 20s for AI Mode to stream response...");
  await page.waitForTimeout(20_000);

  console.log("\n--- Current URL ---");
  console.log(page.url());

  console.log("\n--- Page Title ---");
  console.log(await page.title());

  // Broad selector scan
  const selectors = [
    ".XbIp4e", ".wDYxhc", "[data-md]", ".LDSMQd", ".xpdopen .kno-rdesc",
    "#rso", "#search", ".kp-wholepage", "[data-attrid]", ".mod",
    ".aimode-response", "[data-hveid]", "main", "[role='main']",
    ".M8OgIe", ".EyBRub", ".yDYNvb", ".WaaZC", ".VwiC3b", ".r21Kzd",
    ".Ap5OSd", ".g", ".tF2Cxc", ".IsZvec", ".MjjYud", ".N6jJud",
    "div[data-async-context]", "div[jscontroller]", "div[jsname]",
    ".abuBob", ".WGwSK", ".DoxwDb",
  ];

  console.log("\n--- Selector Match Scan ---");
  for (const sel of selectors) {
    const count = await page.locator(sel).count().catch(() => 0);
    if (count > 0) {
      const text = await page.locator(sel).first().textContent({ timeout: 2_000 }).catch(() => "(error)");
      const preview = (text ?? "").trim().substring(0, 150);
      console.log(`✅ ${sel} — ${count} match(es) — "${preview}"`);
    }
  }

  // Dump outer HTML of body children (top-level structure)
  console.log("\n--- Top-level body children (tag.class) ---");
  const children = await page.evaluate(() => {
    return Array.from(document.body.children).map((el) => {
      const tag = el.tagName.toLowerCase();
      const cls = el.className ? `.${String(el.className).split(/\s+/).join(".")}` : "";
      const id = el.id ? `#${el.id}` : "";
      const text = (el.textContent ?? "").trim().substring(0, 100);
      return `<${tag}${id}${cls}> — "${text}"`;
    });
  });
  children.forEach((c) => console.log("  ", c));

  // Try to get the main content area more broadly
  console.log("\n--- All divs with >200 chars of text (potential response containers) ---");
  const bigDivs = await page.evaluate(() => {
    const results: string[] = [];
    document.querySelectorAll("div").forEach((div) => {
      const text = (div.textContent ?? "").trim();
      if (text.length > 200 && text.length < 10000) {
        const cls = div.className ? String(div.className).substring(0, 80) : "(no class)";
        const id = div.id || "(no id)";
        results.push(`id=${id} class="${cls}" — ${text.length} chars — "${text.substring(0, 120)}"`);
      }
    });
    return results.slice(0, 20);
  });
  bigDivs.forEach((d) => console.log("  ", d));

  // Accessibility snapshot
  console.log("\n--- Accessibility Snapshot (first 4000 chars) ---");
  const snapshot = await page.locator("body").ariaSnapshot().catch(() => "unavailable");
  console.log(snapshot.substring(0, 4000));

  // Screenshot
  const buf = await page.screenshot({ fullPage: true, type: "png" });
  const path = "test/debug-ai-mode-screenshot.png";
  await Bun.write(path, buf);
  console.log(`\nScreenshot saved: ${path}`);

  await browserManager.shutdown();
  console.log("\nDone!");
}

run().catch((err) => {
  console.error("Debug failed:", err);
  browserManager.shutdown().then(() => process.exit(1));
});
