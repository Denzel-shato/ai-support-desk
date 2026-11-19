/**
 * Dashboard preferences: the few settings that really change how this dashboard behaves.
 * Pure code (no React, no Firebase) so the server route, the browser and the tests share one definition.
 * Nothing secret belongs here: these values are sent to the browser.
 */

export const REFRESH_MINUTES = [0, 1, 5, 15] as const;
export const SORT_ORDERS = ["newest", "oldest"] as const;

export interface DashboardSettings {
  /** "auto" = the browser's own zone, otherwise an IANA zone such as "Africa/Harare". */
  timeZone: string;
  /** How often ticket lists reload by themselves; 0 = never (manual Refresh only). */
  autoRefreshMinutes: (typeof REFRESH_MINUTES)[number];
  /** The order the All tickets page opens in. */
  defaultSort: (typeof SORT_ORDERS)[number];
}

export const DEFAULT_SETTINGS: DashboardSettings = {
  timeZone: "auto",
  autoRefreshMinutes: 0,
  defaultSort: "newest",
};

export type SettingsErrors = Partial<Record<keyof DashboardSettings | "form", string>>;

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 64) return false;
  if (value === "auto") return true;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates a save request. Strict on purpose: all three fields are required and unknown fields are
 * refused, so nothing but these values can ever be written.
 */
export function parseSettingsUpdate(
  raw: unknown,
): { ok: true; value: DashboardSettings } | { ok: false; errors: SettingsErrors } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: { form: "The settings must be an object." } };
  }
  const o = raw as Record<string, unknown>;
  const errors: SettingsErrors = {};
  const known = new Set(Object.keys(DEFAULT_SETTINGS));
  const extra = Object.keys(o).filter((k) => !known.has(k));
  if (extra.length) errors.form = `Unknown setting: ${extra.slice(0, 3).join(", ").slice(0, 60)}.`;

  if (!isValidTimeZone(o.timeZone)) errors.timeZone = "Choose a valid time zone.";
  if (!REFRESH_MINUTES.includes(o.autoRefreshMinutes as never)) {
    errors.autoRefreshMinutes = `Choose one of: ${REFRESH_MINUTES.join(", ")} minutes.`;
  }
  if (!SORT_ORDERS.includes(o.defaultSort as never)) errors.defaultSort = "Choose newest or oldest first.";
  if (Object.keys(errors).length) return { ok: false, errors };

  return {
    ok: true,
    value: {
      timeZone: o.timeZone as string,
      autoRefreshMinutes: o.autoRefreshMinutes as DashboardSettings["autoRefreshMinutes"],
      defaultSort: o.defaultSort as DashboardSettings["defaultSort"],
    },
  };
}

/**
 * Turns whatever is stored into usable settings: any missing or invalid field falls back to its default,
 * so a half-written or hand-edited document can never break the dashboard.
 */
export function settingsFromStored(data: Record<string, unknown> | undefined): DashboardSettings {
  const d = data ?? {};
  return {
    timeZone: isValidTimeZone(d.timeZone) ? d.timeZone : DEFAULT_SETTINGS.timeZone,
    autoRefreshMinutes: REFRESH_MINUTES.includes(d.autoRefreshMinutes as never)
      ? (d.autoRefreshMinutes as DashboardSettings["autoRefreshMinutes"])
      : DEFAULT_SETTINGS.autoRefreshMinutes,
    defaultSort: SORT_ORDERS.includes(d.defaultSort as never)
      ? (d.defaultSort as DashboardSettings["defaultSort"])
      : DEFAULT_SETTINGS.defaultSort,
  };
}

export function sameSettings(a: DashboardSettings, b: DashboardSettings): boolean {
  return a.timeZone === b.timeZone && a.autoRefreshMinutes === b.autoRefreshMinutes && a.defaultSort === b.defaultSort;
}

/* ------------------------------ time awareness ------------------------------ */

/** The value to hand to Intl: undefined means "the browser's zone". */
function zoneOption(timeZone: string | undefined): string | undefined {
  return timeZone && timeZone !== "auto" && isValidTimeZone(timeZone) ? timeZone : undefined;
}

/** Hour of day (0-23) in the given zone. */
export function hourIn(date: Date, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: zoneOption(timeZone) }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === "hour")?.value);
  return Number.isFinite(h) ? h % 24 : date.getHours();
}

export type DayPart = "morning" | "afternoon" | "evening";

/** 05:00-11:59 morning, 12:00-16:59 afternoon, 17:00-04:59 evening. */
export function dayPartFor(date: Date, timeZone?: string): DayPart {
  const h = hourIn(date, timeZone);
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  return "evening";
}

export function greetingFor(date: Date, timeZone?: string): string {
  return `Good ${dayPartFor(date, timeZone)}`;
}

export function formatClock(date: Date, timeZone?: string): string {
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: zoneOption(timeZone) });
}

export function formatDateShort(iso: string | null | undefined, timeZone?: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: zoneOption(timeZone) });
}

export function formatDateLong(iso: string | null | undefined, timeZone?: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short", timeZone: zoneOption(timeZone) });
}
