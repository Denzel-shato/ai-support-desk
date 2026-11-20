import "server-only";

import type { Firestore } from "firebase-admin/firestore";
import packageJson from "../../package.json";
import { FirebaseConfigError, getAdminDb } from "./firebase-admin";
import { MAX_ARTICLES } from "./firestore-knowledge-base";
import { TICKETS_COLLECTION, withTimeout } from "./firestore-tickets";
import { KNOWLEDGE_COLLECTION } from "./knowledge-base";
import { readWebhookConfig, WEBHOOK_SECRET_ENV } from "./n8n-send-response";
import { PAGE_SIZE_MAX } from "./ticket-list-query";
import { toIsoOrNull } from "./ticket-serialization";
import type { Check, StatusFacts } from "./settings-status";

/**
 * Measures the facts the Settings page reports. Read-only and cheap: Firestore
 * count aggregations plus one "latest ticket" read, never the whole
 * collections. The n8n webhook is NEVER called (it would send an email), only
 * checked for configuration. No value returned here is a secret.
 */

const CHECK_TIMEOUT_MS = 10_000;
const FIREBASE_ENV = ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"] as const;

function failure(error: unknown): { state: "error"; code: string; message: string } {
  if (error instanceof FirebaseConfigError) {
    return { state: "error", code: "firebase_not_configured", message: error.message };
  }
  const name = (error as { name?: string } | null)?.name;
  if (name === "TicketsTimeoutError") {
    return { state: "error", code: "firestore_timeout", message: "Firestore did not respond in time." };
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 7 || code === 16) {
    return { state: "error", code: "firestore_permission_denied", message: "Firestore rejected the service account. Check its project and permissions." };
  }
  if (code === 14 || code === 4) {
    return { state: "error", code: "firestore_unavailable", message: "Firestore is temporarily unreachable." };
  }
  console.error("[settings/status] Firestore check failed:", error);
  return { state: "error", code: "firestore_error", message: "A Firestore check failed. See the server log." };
}

async function checkTickets(db: Firestore): Promise<Check<{ total: number; latestAt: string | null; sent: number }>> {
  try {
    const col = db.collection(TICKETS_COLLECTION);
    const [total, sent, latest] = await withTimeout(
      Promise.all([
        col.count().get(),
        col.where("responseStatus", "==", "sent").count().get(),
        col.orderBy("createdAt", "desc").limit(1).get(),
      ]),
      CHECK_TIMEOUT_MS,
    );
    const doc = latest.docs[0];
    return {
      state: "ok",
      value: {
        total: total.data().count,
        sent: sent.data().count,
        latestAt: doc ? toIsoOrNull(doc.data().createdAt) : null,
      },
    };
  } catch (error) {
    return failure(error);
  }
}

async function checkArticles(db: Firestore): Promise<Check<{ total: number; active: number }>> {
  try {
    const col = db.collection(KNOWLEDGE_COLLECTION);
    const [total, active] = await withTimeout(
      Promise.all([col.count().get(), col.where("active", "==", true).count().get()]),
      CHECK_TIMEOUT_MS,
    );
    return { state: "ok", value: { total: total.data().count, active: active.data().count } };
  } catch (error) {
    return failure(error);
  }
}

function webhookState(env: Record<string, string | undefined>): StatusFacts["webhook"] {
  const secretSet = Boolean(env[WEBHOOK_SECRET_ENV]?.trim());
  try {
    readWebhookConfig(env);
    return { state: "ok", secretSet };
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    return { state: code === "send_misconfigured" ? "invalid" : "unset", secretSet };
  }
}

export async function gatherStatusFacts(
  env: Record<string, string | undefined> = process.env,
  getDb: () => Firestore = getAdminDb,
  now: () => Date = () => new Date(),
): Promise<StatusFacts> {
  const missing = FIREBASE_ENV.filter((k) => !env[k]?.trim());
  const projectId = env.FIREBASE_PROJECT_ID?.trim() || null;

  let tickets: StatusFacts["tickets"] = { state: "skipped" };
  let articles: StatusFacts["articles"] = { state: "skipped" };
  if (missing.length === 0) {
    try {
      const db = getDb();
      [tickets, articles] = await Promise.all([checkTickets(db), checkArticles(db)]);
    } catch (error) {
      tickets = articles = failure(error);
    }
  }

  return {
    checkedAt: now().toISOString(),
    firebase: { missing: [...missing], projectId },
    tickets,
    articles,
    webhook: webhookState(env),
    runtime: {
      appVersion: packageJson.version,
      nextVersion: packageJson.dependencies.next,
      reactVersion: packageJson.dependencies.react,
      nodeVersion: process.version,
      nodeEnv: env.NODE_ENV ?? "unknown",
    },
    limits: { tickets: PAGE_SIZE_MAX, articles: MAX_ARTICLES },
  };
}
