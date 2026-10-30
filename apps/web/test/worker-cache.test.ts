import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { realpathSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

test("Worker preserves sponsor cache headers but keeps failures and private responses no-store", async () => {
  const require = createRequire(
    realpathSync(new URL("../node_modules/wrangler/package.json", import.meta.url)),
  );
  const { build } = require("esbuild");
  const directory = mkdtempSync(join(tmpdir(), "heybox-worker-cache-"));
  const old = Object.getOwnPropertyDescriptor(globalThis, "caches");
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => {},
      },
    },
  });
  try {
    const output = await build({
      stdin: {
        contents: "export { default } from './src/worker.ts'",
        loader: "ts",
        resolveDir: fileURLToPath(new URL("../", import.meta.url)),
      },
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      plugins: [
        {
          name: "isolate-unrelated-routes",
          setup(builder: any) {
            builder.onResolve({ filter: /^@tanstack\/react-start\/server-entry$/ }, () => ({
              path: "start",
              namespace: "fixture",
            }));
            builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              contents: "export default {fetch: async () => new Response('page')}",
            }));
            builder.onLoad({ filter: /\/server\/api\.ts$/ }, () => ({
              contents:
                "export async function api() { return Response.json({private:true},{headers:{'cache-control':'public, max-age=60'}}); }",
            }));
            builder.onLoad({ filter: /\/server\/page-access\.ts$/ }, () => ({
              contents: "export async function pageAccess() {return null;}",
            }));
            builder.onLoad({ filter: /\/server\/schedule\.ts$/ }, () => ({
              contents: "export async function runScheduled() {}",
            }));
          },
        },
      ],
    });
    const path = join(directory, "worker.mjs");
    writeFileSync(path, output.outputFiles[0].text);
    const worker = (await import(pathToFileURL(path).href)).default;
    const context = { waitUntil: (promise: Promise<unknown>) => void promise };
    const env = {
      SITE_CONFIG: { get: async () => [{ id: "one", name: "One", avatar: "/sponsors/one.jpg" }] },
    };
    for (const method of ["GET", "HEAD"]) {
      const response = await worker.fetch(
        new Request("https://site.invalid/api/sponsors", { method }),
        env,
        context,
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "public, max-age=60");
      if (method === "HEAD") assert.equal(await response.text(), "");
    }
    const missing = await worker.fetch(
      new Request("https://site.invalid/api/sponsors"),
      {},
      context,
    );
    assert.equal(missing.headers.get("cache-control"), "no-store");
    const denied = await worker.fetch(
      new Request("https://site.invalid/api/sponsors", { method: "POST" }),
      env,
      context,
    );
    assert.equal(denied.status, 405);
    assert.equal(denied.headers.get("cache-control"), "no-store");
    const privateResponse = await worker.fetch(
      new Request("https://site.invalid/rpc/dashboard"),
      env,
      context,
    );
    assert.equal(privateResponse.headers.get("cache-control"), "no-store");
  } finally {
    if (old) Object.defineProperty(globalThis, "caches", old);
    else Reflect.deleteProperty(globalThis, "caches");
    rmSync(directory, { recursive: true, force: true });
  }
});
