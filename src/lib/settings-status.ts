import { APP_DESCRIPTION, APP_NAME } from "./app-info";

/**
 * Turns measured facts about the running application into what the Settings
 * page shows. Pure: no React, no Firebase, no env access, no clock. Every
 * statement here is either a fixed fact about how the app is built or derives
 * from a fact the server actually measured. Nothing is marked "connected"
 * unless something was verified.
 */

/** Result of one server-side check: a measured value, an error, or not run. */
export type Check<T> =
  | { state: "ok"; value: T }
  | { state: "error"; code: string; message: string }
  | { state: "skipped" };

export interface StatusFacts {
  checkedAt: string;
  firebase: { missing: string[]; projectId: string | null };
  tickets: Check<{ total: number; latestAt: string | null; sent: number }>;
  articles: Check<{ total: number; active: number }>;
  webhook: { state: "unset" | "invalid" | "ok"; secretSet: boolean };
  runtime: {
    appVersion: string;
    nextVersion: string;
    reactVersion: string;
    nodeVersion: string;
    nodeEnv: string;
  };
  limits: { tickets: number; articles: number };
}

export type Level = "ok" | "warn" | "pending" | "error" | "info";

export interface Row {
  label: string;
  value: string;
}

export interface Integration {
  id: "firebase" | "n8n_pipeline" | "n8n_send" | "gmail";
  name: string;
  level: Level;
  /** Short status text, e.g. "Reachable" or "Awaiting setup". */
  status: string;
  /** Where the work happens, to separate dashboard code from n8n setup. */
  scope: string;
  detail: string;
  facts: Row[];
}

export interface SettingsStatus {
  checkedAt: string;
  workspace: Row[];
  notifications: { title: string; detail: string; where: string }[];
  integrations: Integration[];
  application: Row[];
}

const n = (v: number) => v.toLocaleString("en-US");

function describeDate(iso: string | null): string {
  if (!iso) return "Not recorded";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "Not recorded"
    : d.toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" }) + " UTC";
}

function firebaseIntegration(f: StatusFacts): Integration {
  const base = { id: "firebase" as const, name: "Firebase / Firestore", scope: "Implemented in the dashboard" };

  if (f.firebase.missing.length > 0) {
    return {
      ...base,
      level: "pending",
      status: "Not configured",
      detail:
        "The server-side Firebase credentials are incomplete, so the dashboard can't read tickets or articles.",
      facts: [{ label: "Missing environment variables", value: f.firebase.missing.join(", ") }],
    };
  }

  const checks = [f.tickets, f.articles];
  const failed = checks.find((c) => c.state === "error");
  const facts: Row[] = [
    { label: "Project", value: f.firebase.projectId ?? "Not set" },
    { label: "Credentials", value: "Present on the server (not displayed)" },
  ];
  if (f.tickets.state === "ok") {
    facts.push({ label: "Tickets (support_tickets)", value: n(f.tickets.value.total) });
    facts.push({ label: "Latest ticket received", value: describeDate(f.tickets.value.latestAt) });
  }
  if (f.articles.state === "ok") {
    facts.push({
      label: "Knowledge base (knowledge_base)",
      value: `${n(f.articles.value.total)} ${f.articles.value.total === 1 ? "article" : "articles"}, ${n(f.articles.value.active)} active`,
    });
  }
  if (failed && failed.state === "error") {
    return {
      ...base,
      level: "error",
      status: "Can't read Firestore",
      detail: failed.message,
      facts: [...facts, { label: "Error code", value: failed.code }],
    };
  }
  return {
    ...base,
    level: "ok",
    status: "Reachable",
    detail:
      "Verified just now: the server read the support_tickets and knowledge_base collections with the Admin SDK.",
    facts,
  };
}

function pipelineIntegration(f: StatusFacts): Integration {
  const facts: Row[] = [];
  if (f.tickets.state === "ok") {
    facts.push({
      label: "Tickets written to Firestore",
      value:
        f.tickets.value.total === 0
          ? "None yet"
          : `${n(f.tickets.value.total)}, latest ${describeDate(f.tickets.value.latestAt)}`,
    });
  }
  return {
    id: "n8n_pipeline",
    name: "n8n ticket pipeline (Gemini)",
    level: "info",
    status: "Runs in n8n",
    scope: "Outside the dashboard (existing n8n workflow)",
    detail:
      "Classification, knowledge-base checks and reply drafting by Gemini run inside your n8n workflow, which writes the results to Firestore. The dashboard can't observe n8n or Gemini directly; it only reads what they stored.",
    facts,
  };
}

function sendIntegration(f: StatusFacts): Integration {
  const sent = f.tickets.state === "ok" ? f.tickets.value.sent : null;
  const base = {
    id: "n8n_send" as const,
    name: "n8n send-response webhook",
    scope: "Dashboard code implemented; n8n workflow to be built and tested",
  };

  if (f.webhook.state === "unset") {
    return {
      ...base,
      level: "pending",
      status: "Awaiting setup",
      detail:
        "No webhook URL is set on the server, so sending responses and follow-ups is disabled. Build the n8n send workflow, then set N8N_SEND_RESPONSE_WEBHOOK_URL.",
      facts: [{ label: "Webhook URL", value: "Not set" }],
    };
  }
  if (f.webhook.state === "invalid") {
    return {
      ...base,
      level: "error",
      status: "Misconfigured",
      detail:
        "A webhook URL is set but it isn't usable (it must be a valid https URL; http is allowed only for localhost).",
      facts: [{ label: "Webhook URL", value: "Set, but invalid" }],
    };
  }

  const facts: Row[] = [
    { label: "Webhook URL", value: "Set (hidden)" },
    { label: "Shared secret header", value: f.webhook.secretSet ? "Set" : "Not set (recommended)" },
  ];
  if (sent !== null) facts.push({ label: "Responses confirmed sent by n8n", value: n(sent) });

  if (sent !== null && sent > 0) {
    return {
      ...base,
      level: "ok",
      status: "Delivery confirmed before",
      detail:
        "At least one response was marked sent, which only happens after n8n replied that the email went out. This does not prove it works right now.",
      facts,
    };
  }
  return {
    ...base,
    level: "warn",
    status: "Configured, not verified",
    detail:
      "A URL is set, but no delivery has been confirmed yet and the dashboard doesn't contact the webhook to test it (that would send an email). Treat sending as unproven until the n8n workflow is built and its test checklist passes.",
    facts,
  };
}

function gmailIntegration(): Integration {
  return {
    id: "gmail",
    name: "Gmail delivery",
    level: "info",
    status: "Handled by n8n",
    scope: "Outside the dashboard",
    detail:
      "The dashboard has no Gmail connection of its own. Acknowledgement and escalation emails are sent by the existing n8n workflow; responses and follow-ups are sent through the webhook above, and only count as sent when n8n confirms delivery.",
    facts: [],
  };
}

export function buildSettingsStatus(f: StatusFacts): SettingsStatus {
  return {
    checkedAt: f.checkedAt,
    workspace: [
      { label: "Application", value: APP_NAME },
      { label: "Description", value: APP_DESCRIPTION },
      { label: "Data store", value: f.firebase.projectId ? `Firestore, project ${f.firebase.projectId}` : "Firestore (project not set)" },
      { label: "Sign-in", value: "None. The dashboard has no accounts or authentication: anyone who can open it can use it." },
    ],
    notifications: [
      {
        title: "Customer acknowledgement",
        detail: "Sent automatically when a ticket arrives.",
        where: "Existing n8n workflow",
      },
      {
        title: "Escalation alerts",
        detail: "Internal emails for tickets that need escalation.",
        where: "Existing n8n workflow",
      },
      {
        title: "Responses and follow-ups",
        detail: "Sent only when an agent presses Send in the dashboard (High and Urgent replies need approval first).",
        where: "Dashboard, delivered through the n8n webhook",
      },
    ],
    integrations: [firebaseIntegration(f), pipelineIntegration(f), sendIntegration(f), gmailIntegration()],
    application: [
      { label: "Version", value: `${f.runtime.appVersion} (from package.json)` },
      { label: "Environment", value: f.runtime.nodeEnv === "production" ? "Production build" : f.runtime.nodeEnv === "development" ? "Development" : f.runtime.nodeEnv },
      { label: "Next.js", value: f.runtime.nextVersion },
      { label: "React", value: f.runtime.reactVersion },
      { label: "Node.js", value: f.runtime.nodeVersion },
      { label: "Ticket read limit", value: `${n(f.limits.tickets)} per request` },
      { label: "Knowledge-base read limit", value: `${n(f.limits.articles)} articles` },
    ],
  };
}
