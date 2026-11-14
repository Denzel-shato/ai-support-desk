import "server-only";

import {
  cert,
  getApp,
  getApps,
  initializeApp,
  type App,
} from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

/**
 * Firebase Admin initialisation. Server-only: importing this file from a
 * client component fails the build, so the service-account credentials can
 * never reach the browser.
 */

const REQUIRED_ENV = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
] as const;

/** Thrown when the Firebase credentials are missing or unusable. */
export class FirebaseConfigError extends Error {
  readonly missing: string[];

  constructor(message: string, missing: string[] = []) {
    super(message);
    this.name = "FirebaseConfigError";
    this.missing = missing;
  }
}

/**
 * Private keys pasted into env files usually carry escaped "\n" sequences
 * (and often surrounding quotes). Turn them back into a real PEM string.
 */
function normalizePrivateKey(raw: string): string {
  let key = raw.trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }
  return key.replace(/\\n/g, "\n");
}

function getAdminApp(): App {
  // getApps() survives dev hot reloads, so we never create a duplicate app.
  if (getApps().length > 0) return getApp();

  const missing = REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new FirebaseConfigError(
      `Missing Firebase environment variable${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`,
      [...missing],
    );
  }

  const projectId = process.env.FIREBASE_PROJECT_ID!.trim();
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL!.trim();
  const privateKey = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY!);

  try {
    return initializeApp({
      credential: cert({ projectId, clientEmail, privateKey }),
      projectId,
    });
  } catch {
    // Deliberately drop the original error: it can echo parts of the key.
    throw new FirebaseConfigError(
      "The Firebase service-account credentials could not be parsed. Check that FIREBASE_PRIVATE_KEY is the full key from the downloaded JSON file.",
    );
  }
}

/** Firestore handle for the default database of the configured project. */
export function getAdminDb(): Firestore {
  return getFirestore(getAdminApp());
}
