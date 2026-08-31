import { describe, expect, it } from "vitest";

import { classifyRequestIntent } from "@/lib/projects/classifyIntent";

/** Every example prompt is taken verbatim from the Phase 37 brief itself, both directions. */
describe("classifyRequestIntent", () => {
  it("classifies casual questions as quick", () => {
    expect(classifyRequestIntent("What is WebContainer?")).toBe("quick");
    expect(classifyRequestIntent("Explain how WebContainers work.")).toBe("quick");
    expect(classifyRequestIntent("How does OAuth work?")).toBe("quick");
    expect(classifyRequestIntent("Give me three ideas for a hackathon.")).toBe("quick");
  });

  it("classifies one-off image requests as quick", () => {
    expect(classifyRequestIntent("Generate an image of a futuristic city.")).toBe("quick");
    expect(classifyRequestIntent("Generate a cinematic sunset over the mountains.")).toBe("quick");
    expect(classifyRequestIntent("Generate a sunset over the mountains.")).toBe("quick");
  });

  it("classifies one-off presentation requests as quick", () => {
    expect(classifyRequestIntent("Make me a 5-slide presentation about Newton's laws.")).toBe("quick");
    expect(classifyRequestIntent("Make me a quick 5-slide presentation about the history of aviation.")).toBe("quick");
  });

  it("classifies sustained build requests as project", () => {
    expect(classifyRequestIntent("Build a website for my startup.")).toBe("project");
    expect(classifyRequestIntent("Let's build our hackathon app.")).toBe("project");
    expect(classifyRequestIntent("Create a SaaS dashboard and keep iterating on it.")).toBe("project");
    expect(classifyRequestIntent("Build my portfolio.")).toBe("project");
    expect(classifyRequestIntent("Build me a React portfolio website.")).toBe("project");
    expect(classifyRequestIntent("Build me a portfolio website.")).toBe("project");
  });

  it("recognizes the conversation-to-project transition phrase", () => {
    expect(classifyRequestIntent("Let's build idea #2.")).toBe("project");
  });

  it("treats an empty/whitespace message as quick rather than throwing", () => {
    expect(classifyRequestIntent("   ")).toBe("quick");
    expect(classifyRequestIntent("")).toBe("quick");
  });

  it("falls back to word-count as a soft tiebreaker for an ambiguous long request", () => {
    const longAmbiguous =
      "I have this idea I keep thinking about where people could somehow track their daily habits and reflect on progress over time together with friends";
    expect(classifyRequestIntent(longAmbiguous)).toBe("project");
  });

  it("falls back to quick for a short, ambiguous request", () => {
    expect(classifyRequestIntent("something fun")).toBe("quick");
  });
});
