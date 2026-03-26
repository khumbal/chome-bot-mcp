/**
 * Debug — inspect DOM structure of reference/source links in Google AI Mode and AI Overview
 * Run: bun run test/debug-references.ts
 */
import { browserManager } from "../src/browser.js";

browserManager.setHeadless(false);

async function inspectReferences(page: import("playwright").Page, label: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`--- ${label}: Reference Link Inspection ---`);
  console.log(`URL: ${page.url()}\n`);

  // 1. Find all <a> tags with href inside the response area
  const responseContainers = [
    "#aim-chrome-initial-inline-async-container",
    ".Zkbeff",
    ".CKgc1d",
    ".wDYxhc",
    '[data-attrid="wa:/description"]',
    ".hgKElc",
    ".mod [data-md]",
  ];

  for (const container of responseContainers) {
    const count = await page.locator(container).count().catch(() => 0);
    if (count === 0) continue;

    console.log(`\n📦 Container: ${container} (${count} found)`);

    // Extract all links inside this container
    const links = await page.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return [];
      const anchors = el.querySelectorAll("a[href]");
      return Array.from(anchors).map((a) => ({
        text: (a.textContent ?? "").trim().substring(0, 120),
        href: a.getAttribute("href") ?? "",
        classes: a.className ? String(a.className).substring(0, 80) : "",
        parentClasses: a.parentElement?.className ? String(a.parentElement.className).substring(0, 80) : "",
        dataAttrs: Array.from(a.attributes)
          .filter((attr) => attr.name.startsWith("data-"))
          .map((attr) => `${attr.name}="${attr.value.substring(0, 50)}"`)
          .join(", "),
      }));
    }, container);

    if (links.length === 0) {
      console.log("  (no links found)");
    } else {
      console.log(`  Found ${links.length} links:`);
      for (const link of links.slice(0, 30)) {
        console.log(`  🔗 text="${link.text}"`);
        console.log(`     href="${link.href.substring(0, 150)}"`);
        console.log(`     classes="${link.classes}" parent="${link.parentClasses}"`);
        if (link.dataAttrs) console.log(`     data: ${link.dataAttrs}`);
        console.log();
      }
    }
  }

  // 2. Look for citation/source containers with common class patterns
  const citationSelectors = [
    '[class*="cite"]', '[class*="Cite"]',
    '[class*="source"]', '[class*="Source"]',
    '[class*="ref"]', '[class*="Ref"]',
    '[class*="attribution"]',
    '[class*="footer"]',
    'a[data-ved]',  // Google tracking links
    'cite',  // HTML cite element
    '.VwiC3b',  // Google snippet URL
    '.yuRUbf', // Google result link wrapper
    '.byrV5b', // Google source pill/chip
    '.mnr-c',  // Google source panel
    '.kno-fv', // Knowledge panel links
    '.ULSxyf',  // AI mode citations area
  ];

  console.log("\n--- Citation/Source selector scan ---");
  for (const sel of citationSelectors) {
    const count = await page.locator(sel).count().catch(() => 0);
    if (count > 0) {
      console.log(`\n✅ ${sel} — ${count} match(es)`);
      // Get first 5 matches
      for (let i = 0; i < Math.min(count, 5); i++) {
        const info = await page.locator(sel).nth(i).evaluate((el: Element) => {
          const tag = el.tagName.toLowerCase();
          const cls = el.className ? String(el.className).substring(0, 80) : "";
          const text = (el.textContent ?? "").trim().substring(0, 150);
          const href = el.getAttribute("href") ?? "";
          const outerStart = el.outerHTML.substring(0, 200);
          return { tag, cls, text, href, outerStart };
        }).catch(() => null);
        if (info) {
          console.log(`  [${i}] <${info.tag}> class="${info.cls}" text="${info.text}" href="${info.href.substring(0, 100)}"`);
        }
      }
    }
  }

  // 3. Look for numbered superscript references (e.g. [1], [2])
  console.log("\n--- Superscript/numbered references ---");
  const supRefs = await page.evaluate(() => {
    const results: string[] = [];
    document.querySelectorAll("sup, [class*='superscript'], a[href*='#']").forEach((el) => {
      const text = (el.textContent ?? "").trim();
      if (text.match(/^\d+$/) || text.match(/^\[\d+\]$/)) {
        const parent = el.parentElement;
        results.push(`<${el.tagName.toLowerCase()}> text="${text}" class="${el.className}" parent-class="${parent?.className ?? ""}"`);
      }
    });
    return results.slice(0, 10);
  });
  if (supRefs.length > 0) {
    supRefs.forEach((r: string) => console.log(`  ${r}`));
  } else {
    console.log("  (none found)");
  }

  // 4. Dump aria snapshot of response container for structure clues
  console.log("\n--- Aria snapshot of main response (first 3000 chars) ---");
  for (const sel of ["#aim-chrome-initial-inline-async-container", ".wDYxhc"]) {
    const count = await page.locator(sel).count().catch(() => 0);
    if (count > 0) {
      const snap = await page.locator(sel).first().ariaSnapshot().catch(() => "");
      if (snap) {
        console.log(`\n[${sel}]:`);
        console.log(snap.substring(0, 3000));
        break;
      }
    }
  }
}

async function run() {
  console.log("=== Debug Google Reference Links ===\n");

  const { page } = await browserManager.createPersistentSession("google");
  const query = "what is MCP model context protocol";

  // --- Test AI Mode (udm=50) ---
  const aiModeUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=50&hl=en`;
  console.log("Navigating to AI Mode:", aiModeUrl);
  await page.goto(aiModeUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  console.log("Waiting 20s for AI Mode to stream...");
  await page.waitForTimeout(20_000);
  await inspectReferences(page, "AI Mode (udm=50)");

  // Screenshot
  await page.screenshot({ fullPage: true, path: "test/debug-ref-aimode.png" });
  console.log("\nScreenshot saved: test/debug-ref-aimode.png");

  // --- Test AI Overview (regular search) ---
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`;
  console.log("\n\nNavigating to regular search:", searchUrl);
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(5_000);
  await inspectReferences(page, "Regular Search / AI Overview");

  // Screenshot
  await page.screenshot({ fullPage: true, path: "test/debug-ref-overview.png" });
  console.log("\nScreenshot saved: test/debug-ref-overview.png");

  await browserManager.shutdown();
  console.log("\n=== Done! ===");
}

run().catch((err) => {
  console.error("Debug failed:", err);
  browserManager.shutdown().then(() => process.exit(1));
});
