import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../../../packages/hosting/test/database.ts";
import { Store } from "../../../packages/hosting/src/store.ts";
import { dashboardPollInterval, historyPollInterval } from "../src/lib/dashboard-loader.ts";
import type { Outcome } from "@heybox/contracts";
const credential = (account: number) => ({
  account: String(account),
  version: crypto.randomUUID(),
  ciphertext: "x".repeat(64),
});
const now = Date.parse("2026-10-27T08:00:00+08:00");

test("stable views poll five minutes, retries wake when due, and midnight is not missed", () => {
  const row = {
    id: "j",
    date: "2026-10-27",
    status: "completed",
    attempts: 1,
    updatedAt: now,
    result: null,
    retryAt: null as number | null,
  };
  assert.equal(dashboardPollInterval(row, now), 300000);
  assert.equal(dashboardPollInterval({ ...row, status: "running" }, now), 5000);
  assert.equal(dashboardPollInterval({ ...row, status: "queued", retryAt: now + 8000 }, now), 8000);
  assert.equal(
    dashboardPollInterval({ ...row, status: "queued", retryAt: now + 600000 }, now),
    60000,
  );
  assert.equal(
    historyPollInterval([{ ...row, status: "queued", retryAt: now + 600000 }], now),
    60000,
  );
  assert.equal(
    historyPollInterval([{ ...row, date: "2026-10-26", status: "running" }], now),
    300000,
  );
  assert.equal(dashboardPollInterval(row, Date.parse("2026-10-27T23:59:58+08:00")), 2000);
});

test("idle dispatch performs one read and no writes; expired leases still recover", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 100; i++) await f.store.enroll(credential(i));
    f.db.exec("UPDATE jobs SET status='completed'");
    f.queries.length = 0;
    assert.deepEqual(await f.store.reserveDispatch(), []);
    assert.equal(f.queries.length, 1);
    assert.match(f.queries[0].sql.trim(), /^SELECT/);
    f.db.exec("UPDATE jobs SET status='running',lease='stale',lease_until=1 WHERE rowid=1");
    await f.store.reserveDispatch();
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='running'").get()!.n, 0);
  } finally {
    f.close();
  }
});

test("only two distinct recent HTTP 429 accounts trigger a durable cooldown; queued jobs do not spend attempts", async () => {
  const f = fixture();
  const failure = (status: number, retryAfterMs = 120000): Outcome => ({
    status: "failed",
    failure: {
      category: status === 429 ? "rate_limit" : "http",
      httpStatus: status,
      endpoint: "/task/list_v2/",
      stage: "inspect",
      durationMs: 1,
      retryAfterMs,
    },
  });
  try {
    for (let i = 0; i < 5; i++) await f.store.enroll(credential(i));
    const messages = await f.store.reserveDispatch();
    const a = (await f.store.claimQueued(messages[0]))!;
    await f.store.finish(a.id, a.lease, a.credential.version, failure(429));
    f.advance(4000);
    const b = (await f.store.claimQueued(messages[1]))!;
    await f.store.finish(b.id, b.lease, b.credential.version, failure(403));
    assert.equal(f.db.prepare("SELECT cooldown_until n FROM daily_scheduler").get()!.n, 0);
    f.advance(4000);
    const c = (await f.store.claimQueued(messages[2]))!;
    await f.store.finish(c.id, c.lease, c.credential.version, failure(429, 180000));
    const until = f.store.now() + 180000;
    assert.equal(f.db.prepare("SELECT cooldown_until n FROM daily_scheduler").get()!.n, until);
    f.advance(4000);
    const other = new Store(f.adapter, f.store.now);
    assert.equal(await other.claimQueued(messages[3]), null);
    assert.equal(other.nextStartAt, until);
    assert.equal(f.db.prepare("SELECT SUM(attempts) n FROM jobs").get()!.n, 3);
    assert.deepEqual(await other.reserveDispatch(), []);
    f.advance(until - f.store.now());
    assert.ok(await other.claimQueued(messages[3]));
  } finally {
    f.close();
  }
});

test("old 429 evidence and rejected stale results cannot trigger global cooldown", async () => {
  const f = fixture();
  const failure: Outcome = {
    status: "failed",
    failure: {
      category: "rate_limit",
      httpStatus: 429,
      endpoint: "/task/list_v2/",
      stage: "inspect",
      durationMs: 1,
    },
  };
  try {
    for (let i = 0; i < 3; i++) await f.store.enroll(credential(i));
    const messages = await f.store.reserveDispatch();
    const a = (await f.store.claimQueued(messages[0]))!;
    await f.store.finish(a.id, a.lease, a.credential.version, failure);
    f.advance(61000);
    const b = (await f.store.claimQueued(messages[1]))!;
    await f.store.finish(b.id, b.lease, b.credential.version, failure);
    assert.equal(await f.store.finish(a.id, a.lease, a.credential.version, failure), false);
    assert.equal(f.db.prepare("SELECT cooldown_until n FROM daily_scheduler").get()!.n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM daily_rate_limits").get()!.n, 1);
  } finally {
    f.close();
  }
});

test("report/reconciliation 429s trigger cooldown while an already running task keeps its lease", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 3; i++) await f.store.enroll(credential(i));
    const messages = await f.store.reserveDispatch();
    const jobs = [];
    for (const message of messages) {
      jobs.push((await f.store.claimQueued(message))!);
      f.advance(4000);
    }
    await f.store.finish(jobs[0].id, jobs[0].lease, jobs[0].credential.version, {
      status: "failed",
      failure: {
        category: "rate_limit",
        httpStatus: 429,
        endpoint: "/account/data_report/",
        stage: "share_1",
        durationMs: 1,
      },
    });
    await f.store.finish(jobs[1].id, jobs[1].lease, jobs[1].credential.version, {
      status: "failed",
      failure: {
        category: "http",
        httpStatus: 503,
        endpoint: "/task/sign_v3/sign",
        stage: "sign",
        durationMs: 1,
      },
      errors: [
        {
          category: "rate_limit",
          httpStatus: 429,
          endpoint: "/task/list_v2/",
          stage: "reconcile",
          retryAfterMs: 120000,
          durationMs: 1,
        },
      ],
    });
    assert.equal(
      f.db.prepare("SELECT cooldown_until n FROM daily_scheduler").get()!.n,
      f.store.now() + 120000,
    );
    assert.equal(
      await f.store.heartbeat(jobs[2].id, jobs[2].lease, jobs[2].credential.version),
      true,
    );
    f.advance(61000);
    await f.store.finish(jobs[2].id, jobs[2].lease, jobs[2].credential.version, {
      status: "failed",
      failure: {
        category: "rate_limit",
        httpStatus: 429,
        endpoint: "/task/list_v2/",
        stage: "verify",
        retryAfterMs: 300000,
        durationMs: 1,
      },
    });
    assert.equal(
      f.db.prepare("SELECT cooldown_until n FROM daily_scheduler").get()!.n,
      f.store.now() + 300000,
      "an in-flight request can extend an active cooldown with a later Retry-After",
    );
  } finally {
    f.close();
  }
});
