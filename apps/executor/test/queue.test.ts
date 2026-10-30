import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '@heybox/hosting/store';
import { consume } from '../src/queue.ts';
import type { Env } from '../src/env.ts';
import type { Job } from '@heybox/contracts';

const id = '550e8400-e29b-41d4-a716-446655440000';
const token = '550e8400-e29b-41d4-a716-446655440001';
const job = { id, lease: token, credential: { version: token } } as Job;
function fixture() {
  const events: string[] = [];
  const message = { body: { id, token }, ack: () => events.push('ack'), retry: () => events.push('retry') };
  const batch = { queue: 'heybox-daily-tasks', messages: [message] } as unknown as MessageBatch;
  return { events, batch, env: { DAILY_ENABLED: 'true', CREDENTIAL_KEY: 'fixture' } as Env };
}
test('queue acknowledges only after a durable result write and tolerates a transient D1 failure', async t => {
  const f = fixture(); let writes = 0;
  t.mock.method(Store.prototype, 'claimQueued', async () => job);
  t.mock.method(Store.prototype, 'finish', async () => { if (++writes === 1) throw new Error('temporary D1'); f.events.push('stored'); return true; });
  await consume(f.batch, f.env, async () => ({ status: 'completed' }));
  assert.deepEqual(f.events, ['stored', 'ack']); assert.equal(writes, 2);
});
test('unavailable D1 result persistence retries delivery instead of acknowledging unrecorded success', async t => {
  const f = fixture(); let writes = 0;
  t.mock.method(Store.prototype, 'claimQueued', async () => job);
  t.mock.method(Store.prototype, 'finish', async () => { writes++; throw new Error('D1 unavailable'); });
  await consume(f.batch, f.env, async () => ({ status: 'completed' }));
  assert.deepEqual(f.events, ['retry']); assert.equal(writes, 3);
});
test('duplicate delivery never re-executes an already claimed task and disabled consumers return work to D1', async t => {
  const f = fixture(); let claimed = 0;
  t.mock.method(Store.prototype, 'claimQueued', async () => { claimed++; return null; });
  await consume(f.batch, f.env, async () => { throw new Error('must not execute'); });
  assert.deepEqual(f.events, ['ack']);
  t.mock.method(Store.prototype, 'deferQueued', async () => { f.events.push('deferred'); });
  f.env.DAILY_ENABLED = 'false'; await consume(f.batch, f.env);
  assert.deepEqual(f.events, ['ack', 'deferred', 'ack']); assert.equal(claimed, 1);
});

test('disabled consumers recover even dead-letter deliveries without marking business failure', async t => {
  const f = fixture(); f.env.DAILY_ENABLED = 'false';
  t.mock.method(Store.prototype, 'deadLetter', async () => { f.events.push('failed'); });
  t.mock.method(Store.prototype, 'deferQueued', async () => { f.events.push('deferred'); });
  await consume({ ...f.batch, queue: 'heybox-daily-dead' } as MessageBatch, f.env);
  assert.deepEqual(f.events, ['deferred', 'ack']);
});

test('disabled consumer never acknowledges before durable handback succeeds', async t => {
  const f = fixture(); f.env.DAILY_ENABLED = 'false';
  t.mock.method(Store.prototype, 'deferQueued', async () => { throw new Error('D1 unavailable'); });
  await consume(f.batch, f.env);
  assert.deepEqual(f.events, ['retry']);
});

test('a gate-blocked message is acknowledged only after durable handback; a failed handback retries', async t => {
  const f = fixture();
  t.mock.method(Store.prototype, 'claimQueued', async function (this: Store) { this.nextStartAt = this.now() + 4000; return null; });
  t.mock.method(Store.prototype, 'deferQueued', async (_message: unknown, delay: number) => {
    assert.ok(delay > 0 && delay <= 4000); f.events.push('deferred');
  });
  await consume(f.batch, f.env, async () => { throw new Error('must not execute'); });
  assert.deepEqual(f.events, ['deferred', 'ack']);
  t.mock.method(Store.prototype, 'deferQueued', async () => { throw new Error('D1 unavailable'); });
  await consume(f.batch, f.env);
  assert.deepEqual(f.events, ['deferred', 'ack', 'retry']);
});
