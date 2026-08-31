#!/usr/bin/env node
/**
 * Phase 36 (revised): real-provider smoke test for the active image
 * backend, Cloudflare Workers AI - deliberately NOT part of `npm test`
 * (vitest's default include only matches *.test.ts). Run manually:
 * `node scripts/smokeTestCloudflareImage.mjs`
 *
 * This is the exact check that confirmed, live, before any production
 * code was written: flux-1-schnell returns a real, valid JPEG on the
 * first call (JSON-wrapped base64), and stable-diffusion-v1-5-img2img
 * (editing) failed 3/3 real attempts with "Capacity temporarily
 * exceeded" - a genuine reliability gap in that beta model, not a
 * guess. Re-run this periodically to see if editing has become more
 * reliable.
 */
import fs from "node:fs";

const envText = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const accountId = envText.match(/^CLOUDFLARE_ACCOUNT_ID=(.+)$/m)?.[1]?.trim();
const apiToken = envText.match(/^CLOUDFLARE_API_TOKEN=(.+)$/m)?.[1]?.trim();

if (!accountId || !apiToken) {
  console.error("No CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN found in .env.local - nothing to test.");
  process.exit(1);
}

async function run(model, body, label) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
  console.log(`\n--- ${label} (${model}) ---`);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log("status:", res.status, "| content-type:", res.headers.get("content-type"));
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json = await res.json();
    if (json.success) {
      console.log("SUCCESS - image length:", json.result?.image?.length ?? "n/a");
    } else {
      console.log("FAILED -", JSON.stringify(json.errors));
    }
    return json;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  console.log("SUCCESS (binary) - length:", buf.length, "first bytes:", buf.subarray(0, 8).toString("hex"));
  return null;
}

const gen = await run("@cf/black-forest-labs/flux-1-schnell", { prompt: "a simple red circle on a white background" }, "generateImage");

if (gen?.success) {
  await run(
    "@cf/runwayml/stable-diffusion-v1-5-img2img",
    { prompt: "a simple orange circle on a white background", image_b64: gen.result.image, strength: 0.7 },
    "editImage"
  );
}
