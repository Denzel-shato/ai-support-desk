import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
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
