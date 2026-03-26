/**
 * E2E test — Gemini chat bus
 * Run: bun run test/e2e-gemini.ts
 *
 * PREREQUISITE: You must be logged into Google in the persistent Chrome profile.
 * If not logged in, the test will tell you to log in manually first.
 */
import { browserManager } from "../src/browser.js";
import { geminiChat, geminiNewChat, geminiSummarizeYoutube } from "../src/gemini.js";

browserManager.setHeadless(false);

async function run() {
  console.log("=== Gemini Chat Bus Test ===\n");

  // Test 1: Simple chat
  console.log("--- Test 1: gemini_chat ---");
  const chat1 = await geminiChat({ message: "Hello! What is 2+2? Answer in one word." });
  console.log("isError:", chat1.isError ?? false);
  console.log("Response:", chat1.content[0].text.substring(0, 500));

  if (chat1.isError) {
    console.log("\n⚠ Gemini chat failed — likely needs Google login.");
    console.log("Please log in at the browser window that opened, then re-run this test.");
    // Keep browser open for manual login
    console.log("Waiting 60s for you to log in...");
    await new Promise((r) => setTimeout(r, 60_000));
    await browserManager.shutdown();
    return;
  }

  // Test 2: Follow-up (same conversation)
  console.log("\n--- Test 2: Follow-up chat ---");
  const chat2 = await geminiChat({ message: "Now multiply that by 10" });
  console.log("Response:", chat2.content[0].text.substring(0, 500));

  // Test 3: New chat
  console.log("\n--- Test 3: New chat ---");
  const newChat = await geminiNewChat();
  console.log("Response:", newChat.content[0].text);

  // Test 4: YouTube summary
  console.log("\n--- Test 4: YouTube summary ---");
  const ytResult = await geminiSummarizeYoutube({
    youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  });
  console.log("isError:", ytResult.isError ?? false);
  console.log("Response:", ytResult.content[0].text.substring(0, 800));

  await browserManager.shutdown();
  console.log("\nDone!");
}

run().catch((err) => {
  console.error("Test failed:", err);
  browserManager.shutdown().then(() => process.exit(1));
});
