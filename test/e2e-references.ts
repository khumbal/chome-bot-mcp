/**
 * E2E test — verify both AI Mode and AI Overview extract reference links
 * Run: bun run test/e2e-references.ts
 */
import { googleSearchAiMode, googleSearchAiOverview } from "../src/google.js";
import { browserManager } from "../src/browser.js";

browserManager.setHeadless(false);

async function testAiMode() {
  console.log("=== Test AI Mode References ===\n");
  const result = await googleSearchAiMode({ query: "what is MCP model context protocol" });

  if (result.isError) {
    console.error("AI Mode failed:", result.content[0].text);
    return false;
  }

  const data = JSON.parse(result.content[0].text);
  console.log("Source:", data.source);
  console.log("Content length:", data.content.length, "chars");
  console.log("References count:", data.references?.length ?? 0);

  if (data.references && data.references.length > 0) {
    console.log("\nReferences:");
    for (const ref of data.references.slice(0, 10)) {
      console.log(`  - ${ref.title}: ${ref.url}`);
    }
  }

  const hasRefs = data.references && data.references.length > 0;
  console.log(`\n${hasRefs ? "✅" : "❌"} AI Mode references: ${hasRefs ? "PASS" : "FAIL"}`);
  return hasRefs;
}

async function testAiOverview() {
  console.log("\n=== Test AI Overview/Search References ===\n");
  const result = await googleSearchAiOverview({ query: "what is MCP model context protocol" });

  if (result.isError) {
    console.error("AI Overview failed:", result.content[0].text);
    return false;
  }

  const data = JSON.parse(result.content[0].text);
  console.log("Source:", data.source);
  console.log("Content length:", data.content.length, "chars");
  console.log("References count:", data.references?.length ?? 0);

  if (data.references && data.references.length > 0) {
    console.log("\nReferences:");
    for (const ref of data.references.slice(0, 10)) {
      console.log(`  - ${ref.title}: ${ref.url}`);
    }
  }

  const hasRefs = data.references && data.references.length > 0;
  console.log(`\n${hasRefs ? "✅" : "❌"} AI Overview references: ${hasRefs ? "PASS" : "FAIL"}`);
  return hasRefs;
}

async function run() {
  const aiModePass = await testAiMode();
  const overviewPass = await testAiOverview();

  await browserManager.shutdown();

  console.log("\n=== Summary ===");
  console.log(`AI Mode references: ${aiModePass ? "✅ PASS" : "❌ FAIL"}`);
  console.log(`AI Overview references: ${overviewPass ? "✅ PASS" : "❌ FAIL"}`);
}

run().catch((err) => {
  console.error("Test failed:", err);
  browserManager.shutdown().then(() => process.exit(1));
});
