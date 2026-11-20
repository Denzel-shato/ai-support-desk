// READ-ONLY check of the rate limiter's Firestore TTL setup, run against your REAL project:
//
//   node --env-file=.env.local scripts/check-rate-limit-ttl.mjs
//
// It reads up to 300 documents from the `rate_limits` collection and reports what type `expireAt` really has. It does
// not write, delete or change anything, and it prints no document ids, hashes or credentials. It can NOT show that a TTL
// policy exists (use `gcloud firestore fields ttls list --collection-group=rate_limits`), but stale documents that are
// still present are the visible symptom of a missing or still-propagating policy.
//
// Uses the same variables as the dashboard: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY.
// Exit code: 0 = all expireAt values are Timestamps and none is overdue; 1 = a problem was found; 2 = cannot run.
import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { summarizeTtl } from "./rate-limit-ttl-check.mjs";

const need = ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"];
const missing = need.filter((n) => !process.env[n]?.trim());
if (missing.length) {
  console.error(`Cannot run: missing ${missing.join(", ")}.`);
  process.exit(2);
}
let key = process.env.FIREBASE_PRIVATE_KEY.trim();
if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1);
key = key.replace(/\\n/g, "\n");

try {
  initializeApp({ credential: cert({ projectId: process.env.FIREBASE_PROJECT_ID, clientEmail: process.env.FIREBASE_CLIENT_EMAIL, privateKey: key }) });
  const snap = await getFirestore().collection("rate_limits").limit(300).get();
  const summary = summarizeTtl(snap.docs.map((d) => d.data()), Date.now());
  console.log(`rate_limits documents sampled: ${summary.total}`);
  console.log(`expireAt types: ${JSON.stringify(summary.types)}`);
  console.log(`expired > 48h ago but still present: ${summary.overdue}`);
  if (summary.total === 0) console.log("No documents yet: submit a test through the form first, then run this again.");
  for (const p of summary.problems) console.log(`PROBLEM: ${p}`);
  console.log(summary.ok ? "OK: every sampled expireAt is a Timestamp and nothing is overdue." : "Not confirmed OK.");
  process.exit(summary.problems.length ? 1 : summary.ok ? 0 : 1);
} catch (e) {
  console.error(`Cannot run: ${String(e?.message ?? e).slice(0, 200)}`);
  process.exit(2);
}
