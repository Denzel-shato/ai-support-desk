import { DEFAULT_SETTINGS, parseSettingsUpdate, sameSettings, type DashboardSettings, type SettingsErrors } from "./dashboard-settings";

/**
 * State of the preferences form as a pure reducer, so the rules that matter are testable:
 * a failed save NEVER discards the draft, a save is only possible when the draft is valid and changed,
 * and values arriving from the server never overwrite edits the user has not saved.
 */
export interface SettingsFormState {
  /** What the user is editing. */
  draft: DashboardSettings;
  /** The last values known to be stored on the server. */
  saved: DashboardSettings;
  status: "idle" | "saving" | "saved" | "error";
  message: string | null;
  /** Per-field problems, from local validation or from the server. */
  fields: SettingsErrors;
}

export type SettingsFormAction =
  | { type: "edit"; patch: Partial<DashboardSettings> }
  | { type: "reset-defaults" }
  | { type: "discard" }
  | { type: "loaded"; value: DashboardSettings }
  | { type: "save-started" }
  | { type: "save-succeeded"; value: DashboardSettings }
  | { type: "save-failed"; message: string; fields?: Record<string, string> };

export function initialFormState(saved: DashboardSettings = DEFAULT_SETTINGS): SettingsFormState {
  return { draft: saved, saved, status: "idle", message: null, fields: {} };
}

export const isDirty = (s: SettingsFormState) => !sameSettings(s.draft, s.saved);
export const canSave = (s: SettingsFormState) =>
  s.status !== "saving" && isDirty(s) && parseSettingsUpdate(s.draft).ok;

export function settingsFormReducer(state: SettingsFormState, action: SettingsFormAction): SettingsFormState {
  switch (action.type) {
    case "edit": {
      const draft = { ...state.draft, ...action.patch };
      const parsed = parseSettingsUpdate(draft);
      return { ...state, draft, status: state.status === "saving" ? "saving" : "idle", message: null, fields: parsed.ok ? {} : parsed.errors };
    }
    case "reset-defaults":
      return { ...state, draft: DEFAULT_SETTINGS, status: "idle", message: null, fields: {} };
    case "discard":
      return { ...state, draft: state.saved, status: "idle", message: null, fields: {} };
    case "loaded":
      // Never overwrite unsaved edits with server values.
      return isDirty(state) ? { ...state, saved: action.value } : { ...state, draft: action.value, saved: action.value };
    case "save-started":
      return { ...state, status: "saving", message: null, fields: {} };
    case "save-succeeded":
      return { draft: action.value, saved: action.value, status: "saved", message: "Settings saved.", fields: {} };
    case "save-failed":
      // The draft stays exactly as the user left it.
      return { ...state, status: "error", message: action.message, fields: (action.fields ?? {}) as SettingsErrors };
  }
}
