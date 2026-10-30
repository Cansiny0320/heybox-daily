import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { realpathSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

// Bundle the actual React component. Replace only its network boundary; no real API calls.
test("activities stay idle until opened, reuse results, refresh explicitly and reset on account switch", async () => {
  const require = createRequire(
    realpathSync(new URL("../node_modules/wrangler/package.json", import.meta.url)),
  );
  const { build } = require("esbuild");
  const webRequire = createRequire(new URL("../package.json", import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), "heybox-activity-ui-"));
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const old = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    old.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  let root: { unmount(): void } | undefined;
  let act: (callback: () => unknown) => Promise<void> = async (callback) => {
    callback();
  };
  try {
    const built = await build({
      stdin: {
        contents: `export { Activities } from './src/components/activities.tsx';
      export { calls } from './src/lib/client'; export { createElement, act } from 'react'; export { createRoot } from 'react-dom/client';`,
        resolveDir: fileURLToPath(new URL("../", import.meta.url)),
        loader: "tsx",
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"development"' },
      plugins: [
        {
          name: "mock-network",
          setup(builder: any) {
            builder.onResolve(
              { filter: /^(react|react-dom\/client|react\/jsx-runtime)$/ },
              (args: { path: string }) => ({ path: webRequire.resolve(args.path), external: true }),
            );
            builder.onLoad({ filter: /\/lib\/client\.ts$/ }, () => ({
              contents: `export const calls = [];
          export const client = { activities: async input => { calls.push(input.expectedAccount); return []; } };`,
              loader: "ts",
            }));
          },
        },
      ],
    });
    const file = join(directory, "component.mjs");
    writeFileSync(file, built.outputFiles[0].text);
    const ui = await import(pathToFileURL(file).href);
    act = ui.act;
    const container = dom.window.document.getElementById("root")!;
    const renderer = ui.createRoot(container);
    root = renderer;
    const render = async (account: string, expired = false) =>
      act(async () => {
        renderer.render(
          ui.createElement(ui.Activities, { key: `${account}:${expired}`, account, expired }),
        );
      });
    const toggle = async () =>
      act(async () => {
        container.querySelector<HTMLButtonElement>("[aria-expanded]")!.click();
      });
    await render("1");
    assert.deepEqual(ui.calls, []);
    await toggle();
    assert.deepEqual(ui.calls, ["1"]);
    await toggle();
    await toggle();
    assert.deepEqual(ui.calls, ["1"]);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="刷新活动"]')!.click();
    });
    assert.deepEqual(ui.calls, ["1", "1"]);
    await render("2", true);
    await toggle();
    assert.deepEqual(ui.calls, ["1", "1"]);
    await render("2", false);
    assert.deepEqual(ui.calls, ["1", "1"]);
    await toggle();
    assert.deepEqual(ui.calls, ["1", "1", "2"]);
    await render("3");
    assert.deepEqual(ui.calls, ["1", "1", "2"]);
  } finally {
    if (root)
      await act(async () => {
        root!.unmount();
      });
    dom.window.close();
    for (const [key, descriptor] of old) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
