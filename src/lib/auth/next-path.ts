/** A same-site path to return to after sign-in; anything else becomes "/". */
export function safeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/";
  }
  if (/[\u0000-\u001f\u007f]/.test(value) || value.startsWith("/login") || value.startsWith("/api/")) return "/";
  return value;
}
