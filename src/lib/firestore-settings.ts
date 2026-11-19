import "server-only";

import type { Firestore } from "firebase-admin/firestore";
import { getAdminDb } from "./firebase-admin";
import { settingsFromStored, type DashboardSettings } from "./dashboard-settings";
import { withTimeout } from "./firestore-tickets";

/** One document, written only by the signed-in dashboard through the API (Admin SDK; client access is denied by the rules). */
export const SETTINGS_COLLECTION = "app_settings";
export const SETTINGS_DOC = "dashboard";
const TIMEOUT_MS = 10_000;

export async function readDashboardSettings(db: Firestore = getAdminDb()): Promise<DashboardSettings> {
  const snap = await withTimeout(db.collection(SETTINGS_COLLECTION).doc(SETTINGS_DOC).get(), TIMEOUT_MS);
  return settingsFromStored(snap.exists ? snap.data() : undefined);
}

/** Replaces the whole document with the three validated fields plus audit info. Returns what was stored. */
export async function writeDashboardSettings(
  value: DashboardSettings,
  actor: string | null = null,
  db: Firestore = getAdminDb(),
  nowMs: number = Date.now(),
): Promise<DashboardSettings> {
  const ref = db.collection(SETTINGS_COLLECTION).doc(SETTINGS_DOC);
  await withTimeout(
    ref.set({ ...value, updatedAt: new Date(nowMs).toISOString(), updatedBy: actor }),
    TIMEOUT_MS,
  );
  return readDashboardSettings(db);
}
