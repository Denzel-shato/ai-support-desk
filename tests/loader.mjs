// Test-only module loader: resolves the "@/" alias and extension-less
// TypeScript imports, and replaces `server-only` with an empty module.
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tryFile(base) {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, next) {
  if (specifier === "server-only") {
    return { url: "data:text/javascript,export {}", shortCircuit: true };
  }
  if (specifier === "next/server") {
    return { url: new URL("./next-server-shim.mjs", import.meta.url).href, shortCircuit: true };
  }
  let base = null;
  if (specifier.startsWith("@/")) base = path.join(root, "src", specifier.slice(2));
  else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
    base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
  }
  if (base) {
    const file = tryFile(base);
    if (file?.endsWith(".json")) {
      // JSON imports need an attribute our app code doesn't carry: inline it.
      const body = readFileSync(file, "utf8");
      return { url: `data:text/javascript,export default ${encodeURIComponent(body)}`, shortCircuit: true };
    }
    if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
  }
  try {
    return await next(specifier, context);
  } catch (error) {
    // Next's subpath exports (next/server) have no "exports" map in ESM mode.
    if (error?.code === "ERR_MODULE_NOT_FOUND" && /^next\/[\w-]+$/.test(specifier)) {
      return next(`${specifier}.js`, context);
    }
    throw error;
  }
}
