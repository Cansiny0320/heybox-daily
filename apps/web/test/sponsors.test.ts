import test from "node:test";
import assert from "node:assert/strict";
import { sponsorContent } from "../src/server/sponsors.ts";
import type { Env } from "../src/server/env.ts";

const sponsor = { id: "h-y", name: "H*y", avatar: "/sponsors/h-y.jpg" };
const noCache = {
  match: async () => undefined,
  put: async () => {},
};
const execution = { waitUntil: (promise: Promise<unknown>) => void promise };
const request = (path: string, method = "GET") =>
  new Request(`https://site.invalid${path}`, { method });

test("public sponsor configuration preserves order and only returns display fields", async () => {
  const env = {
    SITE_CONFIG: {
      get: async (key: string, format: string) => {
        assert.equal(key, "sponsors");
        assert.equal(format, "json");
        return [
          { ...sponsor, amount: 2.88 },
          { ...sponsor, id: "second", name: "Second" },
        ];
      },
    },
  } as unknown as Env;
  const response = await sponsorContent(request("/api/sponsors"), env, execution, noCache);
  assert.equal(response?.status, 200);
  assert.equal(response?.headers.get("cache-control"), "public, max-age=60");
  assert.deepEqual(await response?.json(), [sponsor, { ...sponsor, id: "second", name: "Second" }]);
});

test("empty, missing, malformed or unavailable configuration does not break the page", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const value of [
    null,
    [],
    {},
    [{ name: "Missing fields" }],
    [{ ...sponsor, avatar: "https://other.invalid/a.jpg" }],
  ]) {
    const env = { SITE_CONFIG: { get: async () => value } } as unknown as Env;
    const response = await sponsorContent(request("/api/sponsors"), env, execution, noCache);
    assert.deepEqual(await response?.json(), []);
  }
  for (const env of [
    {},
    {
      SITE_CONFIG: {
        get: async () => {
          throw new Error("KV unavailable");
        },
      },
    },
  ]) {
    const response = await sponsorContent(request("/api/sponsors"), env as Env, execution, noCache);
    assert.deepEqual(await response?.json(), []);
  }
});

test("sponsor routes are public read-only and never expose other bucket paths", async () => {
  const env = {
    SPONSOR_ASSETS: { get: async () => assert.fail("must not read R2") },
  } as unknown as Env;
  for (const path of [
    "/sponsors/private.json",
    "/sponsors/nested/a.jpg",
    "/sponsors/%2e%2e%2fsecret.jpg",
  ]) {
    assert.equal((await sponsorContent(request(path), env, execution, noCache))?.status, 404);
  }
  for (const path of ["/api/sponsors", "/sponsors/h-y.jpg"]) {
    const response = await sponsorContent(request(path, "POST"), env, execution, noCache);
    assert.equal(response?.status, 405);
    assert.equal(response?.headers.get("allow"), "GET, HEAD");
  }
  assert.equal(await sponsorContent(request("/tasks"), env, execution, noCache), null);
});

test("R2 avatars use shared cookie-free cache keys and HEAD responses have no body", async () => {
  let reads = 0;
  let stored: Response | undefined;
  const writes: Promise<unknown>[] = [];
  const env = {
    SPONSOR_ASSETS: {
      get: async (key: string) => {
        assert.equal(key, "sponsors/h-y.jpg");
        reads++;
        return {
          body: "avatar bytes",
          size: 12,
          httpEtag: '"avatar-v1"',
          writeHttpMetadata: (headers: Headers) => headers.set("content-type", "image/jpeg"),
        };
      },
    },
  } as unknown as Env;
  const cache = {
    match: async (key: Request) => {
      assert.equal(key.url, "https://site.invalid/sponsors/h-y.jpg");
      assert.equal(key.method, "GET");
      assert.equal(key.headers.get("cookie"), null);
      return stored?.clone();
    },
    put: async (_key: Request, value: Response) => {
      stored = value;
    },
  };
  const context = {
    waitUntil: (promise: Promise<unknown>) => {
      writes.push(promise);
    },
  };
  const response = await sponsorContent(
    new Request("https://site.invalid/sponsors/h-y.jpg?ignored=1", {
      headers: { cookie: "private-session" },
    }),
    env,
    context,
    cache,
  );
  assert.equal(await response?.text(), "avatar bytes");
  assert.equal(response?.headers.get("content-type"), "image/jpeg");
  assert.equal(response?.headers.get("etag"), '"avatar-v1"');
  assert.equal(response?.headers.get("cache-control"), "public, max-age=3600");
  await Promise.all(writes);
  const head = await sponsorContent(request("/sponsors/h-y.jpg", "HEAD"), env, context, cache);
  assert.equal(head?.status, 200);
  assert.equal(await head?.text(), "");
  assert.equal(reads, 1);
});

test("missing avatars return 404 and transient R2 failures remain uncached", async (t) => {
  t.mock.method(console, "error", () => {});
  const cache = {
    ...noCache,
    put: async () => assert.fail("must not cache missing or failed reads"),
  };
  for (const env of [{}, { SPONSOR_ASSETS: { get: async () => null } }]) {
    assert.equal(
      (await sponsorContent(request("/sponsors/h-y.jpg"), env as Env, execution, cache))?.status,
      404,
    );
  }
  const env = {
    SPONSOR_ASSETS: {
      get: async () => {
        throw new Error("R2 unavailable");
      },
    },
  } as unknown as Env;
  const response = await sponsorContent(request("/sponsors/h-y.jpg"), env, execution, cache);
  assert.equal(response?.status, 503);
  assert.equal(response?.headers.get("cache-control"), "no-store");
});

test("cache failure does not prevent serving an R2 avatar", async () => {
  const env = {
    SPONSOR_ASSETS: {
      get: async () => ({ body: "image", size: 5, httpEtag: '"v1"', writeHttpMetadata: () => {} }),
    },
  } as unknown as Env;
  const writes: Promise<unknown>[] = [];
  const response = await sponsorContent(
    request("/sponsors/h-y.jpg", "HEAD"),
    env,
    {
      waitUntil: (promise) => {
        writes.push(promise);
      },
    },
    {
      match: async () => {
        throw new Error("cache read failed");
      },
      put: async () => {
        throw new Error("cache write failed");
      },
    },
  );
  assert.equal(response?.status, 200);
  assert.equal(await response?.text(), "");
  await Promise.all(writes);
});

test("sponsor list caches only successful public reads, shares GET/HEAD and expires", async (t) => {
  t.mock.method(console, "error", () => {});
  let stored: Response | undefined,
    reads = 0,
    now = 0,
    expires = 0,
    fail = false;
  const writes: Promise<unknown>[] = [];
  const cache = {
    match: async (key: Request) => {
      assert.equal(key.url, "https://site.invalid/api/sponsors");
      assert.equal(key.headers.get("cookie"), null);
      return now < expires ? stored?.clone() : undefined;
    },
    put: async (_key: Request, value: Response) => {
      assert.equal(value.headers.get("set-cookie"), null);
      stored = value;
      expires = now + 60000;
    },
  };
  const env = {
    SITE_CONFIG: {
      get: async () => {
        reads++;
        if (fail) throw new Error("KV unavailable");
        return [sponsor];
      },
    },
  } as unknown as Env;
  const context = {
    waitUntil: (p: Promise<unknown>) => {
      writes.push(p);
    },
  };
  for (let i = 0; i < 10; i++) {
    const response = await sponsorContent(
      new Request("https://site.invalid/api/sponsors?q=1", { headers: { cookie: "private" } }),
      env,
      context,
      cache,
    );
    assert.deepEqual(await response!.json(), [sponsor]);
    await Promise.all(writes);
  }
  assert.equal(reads, 1);
  assert.equal(
    await (await sponsorContent(request("/api/sponsors", "HEAD"), env, context, cache))!.text(),
    "",
  );
  now = 60001;
  fail = true;
  assert.equal(
    (await sponsorContent(request("/api/sponsors"), env, context, cache))!.headers.get(
      "cache-control",
    ),
    "no-store",
  );
  fail = false;
  await sponsorContent(request("/api/sponsors"), env, context, cache);
  assert.equal(reads, 3);
});
