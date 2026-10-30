import test from 'node:test';
import assert from 'node:assert/strict';
import { executeDaily } from '../src/operations.ts';
import { encryptCredential } from '@heybox/hosting/crypto';
import { beijingDate } from '@heybox/contracts';

for (const diagnostics of [false, true]) test(`diagnostics=${diagnostics}: executor logs the first sign response, balance and ledger with job correlation and no credentials`, async t => {
  const logs: string[] = []; t.mock.method(console, 'log', (line: string) => logs.push(line));
  const key = Buffer.alloc(32, 7).toString('base64');
  const config = { session: { heybox_id: '12345', pkey: 'private-pkey', device_id: 'private-device', x_xhh_tokenid: 'private-token' },
    device: { model: 'test', osVersion: '17' }, app: { version: '1.3.398', build: '1142', shaderVersion: '14' } };
  const job = { id: crypto.randomUUID(), lease: crypto.randomUUID(), date: beijingDate(), credential: encryptCredential(config, key) };
  let signs = 0, history = 0;
  const day = Math.floor((Date.now() / 1000 + 8 * 3600) / 86400);
  const result = await executeDaily(job, key, { heartbeat: async () => true }, async input => {
    const path = new URL(String(input)).pathname;
    if (path === '/store/hcoin/history/') { history++; return Response.json({ status: 'ok', result: { history: [] } }); }
    if (path === '/task/list_v2/') return Response.json({ status: 'ok', result: {
      user: { userid: '12345', battery: 10, level_info: { exp: 10, coin: 20, level: 1, max_exp: 200 } },
      task_list: [{ title: '每日任务', tasks: ['1', '19', '31'].map(task_id => ({ state: 'finish', report_extra: { task_id } })) }],
    } });
    if (path === '/task/sign_v3/sign') signs++;
    else assert.equal(path, '/task/sign_v4/get_sign_state');
    return Response.json({ status: 'ok', result: { state: path === '/task/sign_v3/sign' ? 1 : 'ok', signed_date: signs ? day : day - 1,
      popup: { data: { sign_in_coin: 100, description: 'private-description' } } } });
  }, { signDiagnostics: diagnostics });
  assert.equal(result.status, 'completed'); assert.equal(result.coinDelta, 0);
  assert.equal(signs, 1); assert.equal(history, diagnostics ? 2 : 0);
  if (!diagnostics) { assert.deepEqual(logs, []); return; }
  const events = logs.map(line => JSON.parse(line));
  assert.deepEqual(events.map(e => e.phase), ['before', 'submitted', 'verified']);
  assert.ok(events.every(e => e.jobId === job.id && e.event === 'executor_sign_diagnostic'));
  assert.equal(events[1].response.state, 'unknown'); assert.equal(events[1].response.state_source, 'redacted');
  assert.equal(events[1].response.state_type, 'number'); assert.equal(events[1].response.state_raw, 1);
  assert.deepEqual(events[1].response.fields, ['state', 'signed_date', 'popup']);
  assert.equal(events[1].response.reward.sign_in_coin, 100);
  assert.deepEqual(events[2].history.entries, []);
  assert.ok(!logs.join().includes('private-')); assert.ok(!logs.join().includes(key));
});
