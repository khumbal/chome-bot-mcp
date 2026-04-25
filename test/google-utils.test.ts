import { describe, expect, test } from "bun:test";
import {
  buildGoogleSearchUrl,
  detectAiModeErrorText,
  googleResultToMarkdown,
  normalizeExtractedText,
  normalizeReferenceUrl,
  shouldRunAiModeFollowUp,
} from "../src/google.js";

describe("Google utility helpers", () => {
  test("builds regular search URLs with recency filters", () => {
    const url = new URL(buildGoogleSearchUrl("model context protocol", "week"));

    expect(url.origin + url.pathname).toBe("https://www.google.com/search");
    expect(url.searchParams.get("q")).toBe("model context protocol");
    expect(url.searchParams.get("hl")).toBe("en");
    expect(url.searchParams.get("tbs")).toBe("qdr:w");
    expect(url.searchParams.has("udm")).toBe(false);
  });

  test("builds direct AI Mode URLs", () => {
    const url = new URL(buildGoogleSearchUrl("deep research", "any", true));

    expect(url.searchParams.get("q")).toBe("deep research");
    expect(url.searchParams.get("udm")).toBe("50");
    expect(url.searchParams.has("tbs")).toBe(false);
  });

  test("normalizes extracted text by trimming whitespace and duplicate lines", () => {
    expect(normalizeExtractedText("  Alpha   beta  \n\nAlpha beta\n Gamma\t delta ")).toBe(
      "Alpha beta\nGamma delta",
    );
  });

  test("unwraps Google redirect reference URLs", () => {
    const url = normalizeReferenceUrl(
      "https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fdocs%23section&sa=U",
    );

    expect(url).toBe("https://example.com/docs#section");
  });

  test("removes text-fragment highlights from reference URLs", () => {
    const url = normalizeReferenceUrl("https://example.com/page#:~:text=highlighted%20text");

    expect(url).toBe("https://example.com/page");
  });

  test("rejects Google internal and unsafe reference URLs", () => {
    expect(normalizeReferenceUrl("/search?q=test")).toBeNull();
    expect(normalizeReferenceUrl("https://policies.google.com/privacy")).toBeNull();
    expect(normalizeReferenceUrl("javascript:alert(1)")).toBeNull();
  });

  test("detects Google AI Mode internal error text", () => {
    expect(detectAiModeErrorText("Something went wrong and the content wasn't generated.")).toBe(
      "Google AI Mode returned an internal error and did not generate content.",
    );
    expect(detectAiModeErrorText("Useful AI Mode answer content.")).toBeNull();
  });

  test("renders Google result payloads as readable Markdown", () => {
    const markdown = googleResultToMarkdown({
      source: "google_ai_mode",
      query: "model context protocol",
      content: "MCP connects models to external tools and context.",
      references: [
        { title: "Model Context Protocol", url: "https://modelcontextprotocol.io/" },
        { title: "Docs [overview]", url: "https://example.com/docs" },
      ],
      refinements: [
        {
          prompt: "Please expand with implementation details.",
          content: "A fuller answer should cover clients, servers, tools, and resources.",
        },
      ],
      note: "AI Mode response did not stabilize before timeout; returning the latest captured content.",
    });

    expect(markdown).toContain("# Google AI Mode");
    expect(markdown).toContain("**Query:** model context protocol");
    expect(markdown).toContain("MCP connects models to external tools and context.");
    expect(markdown).toContain("> AI Mode response did not stabilize before timeout");
    expect(markdown).toContain("## Follow-up Expansion");
    expect(markdown).toContain("Please expand with implementation details.");
    expect(markdown).toContain("A fuller answer should cover clients, servers, tools, and resources.");
    expect(markdown).toContain("1. [Model Context Protocol](https://modelcontextprotocol.io/)");
    expect(markdown).toContain("2. [Docs \\[overview\\]](https://example.com/docs)");
  });

  test("decides when AI Mode follow-up should run", () => {
    expect(shouldRunAiModeFollowUp("short answer", {
      prompt: "Expand this answer.",
      mode: "always",
      minContentLength: 1000,
    })).toBe(true);

    expect(shouldRunAiModeFollowUp("short answer", {
      prompt: "Expand this answer.",
      mode: "if_short",
      minContentLength: 1000,
    })).toBe(true);

    expect(shouldRunAiModeFollowUp("This answer is long enough for the configured threshold.", {
      prompt: "Expand this answer.",
      mode: "if_short",
      minContentLength: 10,
    })).toBe(false);
  });
});
