import test from "node:test";
import assert from "node:assert/strict";
import {
  createDashboardLoader,
  dashboardPollInterval,
  type DashboardData,
} from "../src/lib/dashboard-loader.ts";
import { publicStats } from "../src/server/stats.ts";
import type { Env } from "../src/server/env.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
function dashboard(status = "running", account = "123", day = "2026-10-27"): DashboardData {
  const row = {
    id: `${account}:${day}`,
    date: day,
    status,
    attempts: 1,
    updatedAt: 1,
    retryAt: null,
    result: null,
  };
  return {
    account,
    nickname: account,
    avatar: null,
    enabled: true,
    credentialState: "valid",
    nextRunAt: 1,
    today: row,
    history: [row, { ...row, id: "yesterday", date: "2026-10-26", status: "completed" }],
  };
}

test("dashboard requests coalesce and polls retain history without fetching it again", async () => {
  const first = deferred<DashboardData>();
  const calls: boolean[] = [];
  const loader = createDashboardLoader(
    async (history) => {
      calls.push(history);
      return calls.length === 1 ? first.promise : { ...dashboard(), history: [] };
    },
    () => "2026-10-27",
  );
  const a = loader.load();
  const b = loader.load();
  assert.deepEqual(calls, [true]);
  first.resolve(dashboard());
  assert.deepEqual(await a, await b);
  const poll = await loader.load();
  assert.deepEqual(calls, [true, false]);
  assert.equal(poll.history.length, 2);
});
test("the daily page only reads today's job, including completion and mutation refreshes", async () => {
  const calls: boolean[] = [];
  const loader = createDashboardLoader(
    async (history) => {
      calls.push(history);
      return dashboard(calls.length === 1 ? "running" : "completed");
    },
    undefined,
    false,
  );
  await loader.load();
  await loader.load();
  await loader.load(true);
  assert.deepEqual(calls, [false, false, false]);
});

test("completion, account changes and a new day reload the correct history", async () => {
  for (const change of ["completion", "account", "day"]) {
    let value = dashboard();
    let day = "2026-10-27";
    const calls: boolean[] = [];
    const loader = createDashboardLoader(
      async (history) => {
        calls.push(history);
        return { ...value, history: history ? value.history : [] };
      },
      () => day,
    );
    await loader.load();
    value = change === "account" ? dashboard("queued", "456") : dashboard("completed");
    if (change === "day") {
      day = "2026-10-28";
      value = dashboard("queued", "123", day);
    }
    assert.deepEqual(await loader.load(), value);
    assert.deepEqual(calls, change === "day" ? [true, true] : [true, false, true]);
  }
});

test("a mutation refresh waits for an old read then fetches a fresh full snapshot", async () => {
  const first = deferred<DashboardData>();
  let reads = 0;
  const loader = createDashboardLoader(async () =>
    ++reads === 1 ? first.promise : dashboard("completed"),
  );
  const pending = loader.load();
  const afterMutation = loader.load(true);
  const nextPoll = loader.load();
  assert.equal(reads, 1);
  first.resolve(dashboard());
  await pending;
  assert.equal((await afterMutation).today?.status, "completed");
  assert.equal((await nextPoll).today?.status, "completed");
  assert.equal(reads, 2);
});

test("public statistics share a cookie-free cache key, expire after five minutes and avoid database reads on hits", async () => {
  let now = 0;
  let reads = 0;
  let count = 10;
  let stored: { response: Response; expires: number } | undefined;
  const writes: Promise<unknown>[] = [];
  const cache = {
    async match(request: Request) {
      assert.equal(request.url, "https://site.invalid/api/stats");
      assert.equal(request.headers.get("cookie"), null);
      return stored && stored.expires > now ? stored.response.clone() : undefined;
    },
    async put(request: Request, response: Response) {
      assert.equal(request.url, "https://site.invalid/api/stats");
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(response.headers.get("cache-control"), "public, max-age=300");
      stored = { response, expires: now + 300_000 };
    },
  };
  const env = {
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            reads++;
            return { count };
          },
        }),
      }),
    },
  } as unknown as Env;
  const execution = {
    waitUntil: (promise: Promise<unknown>) => {
      writes.push(promise);
    },
  };
  const request = () =>
    new Request("https://site.invalid/api/stats?ignored=1", {
      headers: { cookie: "session=private" },
    });
  assert.deepEqual(await (await publicStats(request(), env, execution, cache)).json(), {
    accounts: 10,
  });
  await Promise.all(writes);
  count = 11;
  assert.deepEqual(await (await publicStats(request(), env, execution, cache)).json(), {
    accounts: 10,
  });
  assert.equal(reads, 1);
  now = 300_001;
  assert.deepEqual(await (await publicStats(request(), env, execution, cache)).json(), {
    accounts: 11,
  });
  assert.equal(reads, 2);
});

test("statistics remain available if the edge cache is unavailable", async () => {
  const env = {
    DB: { prepare: () => ({ bind: () => ({ first: async () => ({ count: 7 }) }) }) },
  } as unknown as Env;
  const writes: Promise<unknown>[] = [];
  const response = await publicStats(
    new Request("https://site.invalid/api/stats"),
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
  assert.deepEqual(await response.json(), { accounts: 7 });
  await Promise.all(writes);
});

test("cached statistics retain the five-minute browser TTL when Cloudflare rewrites headers", async () => {
  const cached = Response.json(
    { accounts: 7 },
    {
      headers: { "Cache-Control": "public, max-age=14400", Age: "30" },
    },
  );
  const response = await publicStats(
    new Request("https://site.invalid/api/stats"),
    {} as Env,
    { waitUntil: () => assert.fail("cache hits must not write") },
    { match: async () => cached, put: async () => assert.fail("cache hits must not write") },
  );
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  assert.equal(response.headers.get("age"), "30");
  assert.deepEqual(await response.json(), { accounts: 7 });
});

test("future retries poll slowly until due while running work polls quickly", () => {
  const today = dashboard("queued").today!;
  const now = Date.parse("2026-10-27T08:00:00+08:00");
  assert.equal(dashboardPollInterval({ ...today, retryAt: now + 60000 }, now), 60000);
  assert.equal(dashboardPollInterval({ ...today, retryAt: now }, now), 5000);
  assert.equal(dashboardPollInterval({ ...today, retryAt: null }, now), 5000);
  assert.equal(
    dashboardPollInterval({ ...today, status: "running", retryAt: now + 60000 }, now),
    5000,
  );
  assert.equal(dashboardPollInterval({ ...today, status: "completed" }, now), 300000);
  assert.equal(dashboardPollInterval(undefined, now), 60000);
});
