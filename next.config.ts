import type { NextConfig } from "next";

/**
 * Response headers for every route. The dashboard shows customer details and has approve/send buttons,
 * so it must not be framed by another site (clickjacking) or have its responses content-sniffed.
 * No script-src/style-src policy on purpose: Next injects inline scripts, so a strict one needs
 * per-request nonces; the directives below are safe without that.
 */
export const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  // Keep Firebase Admin as a native Node dependency (not bundled), which also
  // guarantees one shared app instance across dev hot reloads.
  serverExternalPackages: ["firebase-admin"],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
