import test from 'node:test';
import assert from 'node:assert/strict';
import { HeyboxClient } from '../dist/client.js';

const config = { session: { heybox_id: '123', pkey: 'fixture', x_xhh_tokenid: 'fixture', device_id: 'fixture' },
  device: { model: 'fixture', osVersion: '17' }, app: { version: '1.3.398', build: '1142', shaderVersion: '14' } };

for (const [name, response, error] of [
  ['success', () => Response.json({ status: 'ok', result: { valid: true } }), undefined],
  ['HTTP error', () => new Response('unavailable', { status: 503 }), /HTTP 503/],
  ['business rejection', () => Response.json({ status: 'failed' }), /接口未成功/],
  ['invalid JSON', () => new Response('invalid'), /非 JSON/],
  ['network failure', () => { throw new Error('network unavailable'); }, /请求失败或超时/],
] as const) {
  test(`completed ${name} does not leave an abort scheduled`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let signal: AbortSignal | undefined;
    const client = new HeyboxClient(config, { fetchImpl: async (_url, options) => {
      signal = options?.signal ?? undefined;
      return response();
    } });
    if (error) await assert.rejects(client.tasks(), error);
    else assert.deepEqual(await client.tasks(), { valid: true });
    assert.ok(signal);
    t.mock.timers.tick(20_000);
    assert.equal(signal.aborted, false, 'finished requests must release their deadline');
  });
}

test('HTTP error closes an unfinished response body before returning', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('unavailable')); },
    cancel() { cancelled = true; },
  }), { status: 503 });
  const client = new HeyboxClient(config, { fetchImpl: async () => response });
  await assert.rejects(client.tasks(), /HTTP 503/);
  assert.equal(cancelled, true, 'discarded bodies must not leave network I/O open');
});

test('pending requests still time out after 20 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined;
  const client = new HeyboxClient(config, { fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
    signal = options?.signal ?? undefined;
    signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
  }) });
  const rejected = assert.rejects(client.tasks(), /请求失败或超时/);
  assert.ok(signal);
  t.mock.timers.tick(19_999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(signal.reason.name, 'TimeoutError');
});

test('the timeout remains active while the response body is being read', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined;
  const client = new HeyboxClient(config, { fetchImpl: async (_url, options) => {
    signal = options?.signal ?? undefined;
    return new Response(new ReadableStream({ start(controller) {
      signal!.addEventListener('abort', () => controller.error(signal!.reason), { once: true });
    } }));
  } });
  const rejected = assert.rejects(client.tasks(), /非 JSON/);
  await Promise.resolve();
  assert.ok(signal);
  t.mock.timers.tick(19_999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(signal.reason.name, 'TimeoutError');
});
