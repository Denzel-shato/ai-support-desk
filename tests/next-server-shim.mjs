// Test-only: the real `connection()` throws outside a Next request. Everything
// else (NextResponse etc.) is the real implementation.
export * from "next/server.js";
export const connection = async () => {};
