import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import fs from "node:fs";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n").filter(l => l.includes("=")).map(l => {
    const idx = l.indexOf("=");
    let v = l.slice(idx+1);
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1,-1);
    return [l.slice(0,idx), v];
  })
);

initializeApp({ credential: cert({
  projectId: env.FIREBASE_ADMIN_PROJECT_ID,
  clientEmail: env.FIREBASE_ADMIN_CLIENT_EMAIL,
  privateKey: env.FIREBASE_ADMIN_PRIVATE_KEY.replace(/\\n/g, "\n"),
})});

const db = getFirestore();
const sessionId = process.argv[2];
const turn = (await db.collection("agentTurns").doc(sessionId).get()).data();
const host = (await db.collection("runtimeHost").doc(sessionId).get()).data();
const files = await db.collection("sessionFiles").where("sessionId","==",sessionId).get();

console.log(JSON.stringify({
  active: turn?.active,
  iterations: turn?.telemetry?.iterations,
  toolCalls: turn?.telemetry?.toolCalls,
  failedActions: turn?.telemetry?.failedActions,
  termination: turn?.telemetry?.terminationReason,
  timeToFirstRunMs: turn?.telemetry?.timeToFirstRunMs,
  timeToFirstPreviewMs: turn?.telemetry?.timeToFirstPreviewMs,
  totalDurationMs: turn?.telemetry?.totalDurationMs,
  hostState: host?.state,
  port: host?.port,
  previewUrl: host?.previewUrl,
  errorMessage: host?.errorMessage,
  fileCount: files.size,
}));
