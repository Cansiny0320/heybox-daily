// Local fixtures only. Pass a saved pre-change checkout directory for exact Store comparisons.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createHmac } from "node:crypto";
import { fixture } from "../../../packages/hosting/test/database.ts";
import { Store } from "../../../packages/hosting/src/store.ts";
import { taskIds } from "@heybox/contracts";
import { createAuth } from "../src/server/auth.ts";
import { sessionAuth } from "../src/server/session-auth.ts";
import type { Env } from "../src/server/env.ts";

const baseline = process.argv[2];
if (!baseline) throw new Error("Usage: node test/quota-benchmark.ts /absolute/pre-change-checkout");
const BeforeStore: typeof Store = (
  await import(pathToFileURL(resolve(baseline, "packages/hosting/src/store.ts")).href)
).Store;
const credential = (id: number) => ({
  account: String(id),
  version: crypto.randomUUID(),
  ciphertext: "x".repeat(64),
});
async function idle(Constructor: typeof Store) {
  const f = fixture();
  try {
    const store = new Constructor(f.adapter, f.store.now);
    for (let i = 0; i < 1600; i++) await store.enroll(credential(i));
    f.db.exec("UPDATE jobs SET status='completed'");
    f.queries.length = 0;
    const changes = Number(f.db.prepare("SELECT total_changes() n").get()!.n);
    await store.reserveDispatch();
    return {
      sqlStatements: f.queries.length,
      changedRows: Number(f.db.prepare("SELECT total_changes() n").get()!.n) - changes,
    };
  } finally {
    f.close();
  }
}
async function burst(Constructor: typeof Store, handback: boolean) {
  const f = fixture();
  try {
    const store = new Constructor(f.adapter, f.store.now),
      start = store.now();
    for (let i = 0; i < 8; i++) await store.enroll(credential(i));
    type Delivery = { at: number; tries: number; id: string; token: string };
    const pending: Delivery[] = [];
    let reads = 0,
      writes = 0,
      acks = 0,
      dlq = 0,
      executions = 0;
    const starts: number[] = [];
    async function dispatch(initial = false) {
      const messages = await store.reserveDispatch();
      for (const m of messages)
        pending.push({
          ...m,
          tries: 0,
          at: initial ? start + 60000 : store.now() + m.delaySeconds * 1000,
        });
      writes += messages.length;
      if (messages.length) await store.markDispatched(messages[0].token);
    }
    await dispatch(true);
    let cron = start + 60000;
    while (executions < 8 && store.now() < start + 600000) {
      pending.sort((a, b) => a.at - b.at);
      const next = Math.min(cron, pending[0]?.at ?? Infinity);
      f.advance(next - store.now());
      if (cron === next) {
        await dispatch();
        cron += 60000;
      }
      while (pending[0]?.at <= store.now()) {
        const m = pending.shift()!;
        reads++;
        const job = await store.claimQueued(m);
        if (job) {
          starts.push(store.now());
          executions++;
          await store.finish(job.id, job.lease, job.credential.version, {
            status: "completed",
            snapshot: { exp: 1, coin: 1, tasks: taskIds.map((id) => ({ id, state: "finish" })) },
          });
          acks++;
        } else if (store.nextStartAt !== null) {
          if (handback) {
            await store.deferQueued(m, store.nextStartAt - store.now());
            acks++;
          } else if (m.tries < 5) pending.push({ ...m, tries: m.tries + 1, at: store.nextStartAt });
          else {
            dlq++;
            await store.deadLetter(m);
          }
        } else acks++;
        pending.sort((a, b) => a.at - b.at);
      }
    }
    assert.equal(executions, 8);
    assert.equal(Number(f.db.prepare("SELECT SUM(attempts) n FROM jobs").get()!.n), 8);
    assert.ok(starts.slice(1).every((at, i) => at - starts[i] >= 4000));
    return {
      producerWrites: writes,
      mainQueueReads: reads,
      mainQueueAcks: acks,
      dlqTransfers: dlq,
      executions,
      elapsedMs: store.now() - start,
    };
  } finally {
    f.close();
  }
}
async function authBenchmark() {
  const f = fixture();
  try {
    await f.store.enroll(credential(1));
    const token = "benchmark-token",
      secret = "local-benchmark-secret-at-least-32-chars";
    f.db
      .prepare(
        "INSERT INTO session(id,user_id,token,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      )
      .run("session", "heybox:1", token, Date.now() + 3600000, Date.now(), Date.now());
    const env = {
      DB: f.adapter,
      SITE_URL: "http://localhost",
      BETTER_AUTH_SECRET: secret,
    } as unknown as Env;
    const headers = new Headers({
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${createHmac("sha256", secret).update(token).digest("base64")}`)}`,
    });
    const before = () => createAuth(env, { waitUntil: () => {} }).api.getSession({ headers });
    const after = () => sessionAuth(env).api.getSession({ headers });
    for (let i = 0; i < 30; i++) {
      await before();
      await after();
    }
    const measurements: Record<string, number[]> = { before: [], after: [] };
    const count = 200;
    for (let round = 0; round < 5; round++)
      for (const [name, run] of (round % 2
        ? [
            ["after", after],
            ["before", before],
          ]
        : [
            ["before", before],
            ["after", after],
          ]) as Array<[string, typeof before]>) {
        const cpu = process.cpuUsage();
        for (let i = 0; i < count; i++) assert.equal((await run())?.user.id, "heybox:1");
        const elapsed = process.cpuUsage(cpu);
        measurements[name].push((elapsed.user + elapsed.system) / 1000 / count);
      }
    return Object.fromEntries(
      Object.entries(measurements).map(([name, rounds]) => [
        name,
        { cpuMsPerReadMedian: [...rounds].sort((a, b) => a - b)[2], rounds },
      ]),
    );
  } finally {
    f.close();
  }
}
console.log(
  JSON.stringify(
    {
      fixture:
        "1600 completed jobs; 8 messages delayed together by 60s; 5x200 authenticated session reads",
      idle: { before: await idle(BeforeStore), after: await idle(Store) },
      burst: { before: await burst(BeforeStore, false), after: await burst(Store, true) },
      sessionAuth: await authBenchmark(),
    },
    null,
    2,
  ),
);
