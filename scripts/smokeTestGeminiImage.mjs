#!/usr/bin/env node
/**
 * Phase 36 STEP 20: "add one explicit real-provider smoke test
 * separately from the deterministic unit suite" - this hits the real
 * Gemini API with the real configured key, deliberately NOT picked up
 * by `npm test` (vitest's default include only matches *.test.ts).
 * Run manually: `node scripts/smokeTestGeminiImage.mjs`
 *
 * Confirms, against the live API, not assumptions:
 * - the model name is currently valid (a 429 means recognized-but-
 *   quota-limited; a 404 means the name itself is wrong)
 * - what the account's actual quota state is right now
 * - if quota allows it, the real response shape for a successful
 *   generation (this is the one thing this session could NOT verify
 *   live - every attempt hit a real 0-quota wall on this project, see
 *   lib/images/providers/geminiImage.ts's own doc comment)
 */
import fs from "node:fs";
import OpenAI from "openai";

const envText = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const match = envText.match(/^GEMINI_API_KEY=(.+)$/m);
if (!match) {
  console.error("No GEMINI_API_KEY found in .env.local - nothing to test.");
  process.exit(1);
}
const apiKey = match[1].trim().replace(/^"|"$/g, "");
const model = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";

const client = new OpenAI({ apiKey, baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/" });

console.log(`Testing image generation with model "${model}"...`);

try {
  const completion = await client.chat.completions.create(
    {
      model,
      messages: [{ role: "user", content: "a simple red circle on a white background" }],
      modalities: ["image", "text"],
    },
    { timeout: 60_000, maxRetries: 0 }
  );

  const message = completion.choices[0]?.message;
  console.log("SUCCESS - full message shape:");
  console.log(JSON.stringify(message, null, 2).slice(0, 2000));
} catch (error) {
  console.log(`FAILED - status ${error.status ?? "n/a"}`);
  console.log(error.message?.slice(0, 500));
  if (error.status === 404) {
    console.log("\n-> 404 means the model name itself is wrong/unavailable - check the current model name.");
  } else if (error.status === 429) {
    console.log("\n-> 429 means the model name IS valid but this key/project has no usable quota right now.");
  }
}
