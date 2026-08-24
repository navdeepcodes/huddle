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
const ids = process.argv.slice(2);
const LABEL_BY_ID = {
  dKGsiY2maTMxDJIgc6Bl: "A (ecommerce)",
  P0Rt9VB6XgjwUxa4n90T: "B (SaaS dashboard)",
  b3RrUF4tQ3fQj6QjKn3q: "C (editorial)",
};

for (let i = 0; i < ids.length; i++) {
  const sessionId = ids[i];
  const turn = (await db.collection("agentTurns").doc(sessionId).get()).data();
  const host = (await db.collection("runtimeHost").doc(sessionId).get()).data();
  const files = await db.collection("sessionFiles").where("sessionId","==",sessionId).get();
  console.log(JSON.stringify({
    label: LABEL_BY_ID[sessionId] ?? sessionId,
    sessionId,
    active: turn?.active,
    iterations: turn?.telemetry?.iterations,
    toolCalls: turn?.telemetry?.toolCalls,
    successfulActions: turn?.telemetry?.successfulActions,
    failedActions: turn?.telemetry?.failedActions,
    repeatedIterations: turn?.telemetry?.repeatedIterations,
    termination: turn?.telemetry?.terminationReason,
    timeToFirstRunMs: turn?.telemetry?.timeToFirstRunMs,
    timeToFirstPreviewMs: turn?.telemetry?.timeToFirstPreviewMs,
    totalDurationMs: turn?.telemetry?.totalDurationMs,
    hostState: host?.state,
    fileCount: files.size,
    subgoals: turn?.taskState?.subgoals?.map(s => `${s.description} [${s.status}]`),
  }));
}
