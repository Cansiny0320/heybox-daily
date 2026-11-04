import test from 'node:test';
import assert from 'node:assert/strict';
import { runDaily } from '../dist/tasks.js';
import type { TaskClient } from '../dist/types.js';
import { readSignHistory, signResponse } from '../dist/sign-diagnostics.js';

const now = () => Date.parse('2026-10-28T01:00:00Z');
const signed = { state: 'ok', signed_date: 20754 };
test('first-submit diagnostics distinguish response states from an absent state', () => {
  for (const state of ['success', 'fail', 'failed', 'pending', 'ok', 'ignore', 'waiting', 'unknown']) {
    const value = signResponse({ state });
    assert.equal(value.state, state);
    assert.equal(value.state_source, 'value');
  }
  const empty = signResponse({});
  assert.equal(empty.state, 'unknown'); assert.equal(empty.state_source, 'missing');
  assert.equal(empty.result_type, 'object'); assert.equal(empty.field_count, 0);
  assert.equal(signResponse(null).result_type, 'null');
  assert.equal(signResponse([]).result_type, 'array');
});
test('records the exact state value and JSON type, including values excluded from the legacy summary', () => {
  for (const [state, type] of [[1, 'number'], ['1', 'string'], [false, 'boolean'],
    [null, 'null'], ['', 'string'], ['SUCCESS', 'string'], ['a'.repeat(33), 'string'],
    [{ code: 1 }, 'object'], [[1, 'ok'], 'array']] as const) {
    const value = JSON.parse(JSON.stringify(signResponse({ state, pkey: 'private-key', description: 'private-description' })));
    assert.equal(value.state_type, type);
    assert.deepEqual(value.state_raw, state);
    assert.ok(!JSON.stringify(value).includes('private-'));
  }
  const missing = JSON.parse(JSON.stringify(signResponse({})));
  assert.equal(missing.state_type, 'missing');
  assert.equal(Object.hasOwn(missing, 'state_raw'), false);
});
test('response shape diagnostics retain only known field names alongside the raw state', () => {
  const value = signResponse({ state: 'NOT_OK.1', pkey: 'private-key',
    'private-field': 'private-value', description: 'private-description', signed_date: 20754 });
  assert.equal(value.state, 'unknown'); assert.equal(value.state_source, 'redacted');
  assert.equal(value.state_raw, 'NOT_OK.1');
  assert.deepEqual(value.fields, ['state', 'signed_date', 'description']);
  assert.equal(value.field_count, 5);
  assert.ok(!JSON.stringify(value).includes('private-'));
  for (const state of ['a'.repeat(33), 12345, null, { pkey: 'private-key' }]) {
    assert.equal(signResponse({ state }).state_source, 'redacted');
  }
});
test('preserves the APP waiting state and reward fields from both supported response shapes', () => {
  const reward = { sign_in_exp: '100', sign_in_coin: '110', plus_hcoin: true, secret: 'private-value' };
  for (const response of [{ state: 'waiting', ...reward }, { state: 'waiting', popup: { data: reward } }]) {
    const value = signResponse(response);
    assert.equal(value.state, 'waiting'); assert.equal(value.reward.sign_in_coin, 110);
    assert.equal(value.reward.sign_in_exp, 100); assert.equal(value.reward.plus_hcoin, true);
    assert.ok(!JSON.stringify(value).includes('private-value'));
  }
});
function fixture(options: { failSign?: boolean; failHistory?: boolean; failReadback?: boolean; alreadySigned?: boolean; reward?: boolean } = {}) {
  let signs = 0;
  let historyReads = 0;
  const events: unknown[] = [];
  const client: TaskClient = {
    tasks: async () => {
      if (signs && options.failReadback) throw new Error('private-readback');
      const gain = signs && options.reward ? 100 : 0;
      return { user: { userid: '12345', battery: 2 + (gain ? 1 : 0), level_info: { exp: 10 + gain, coin: 20 + gain, level: 1, max_exp: 200 } },
        task_list: [{ title: '每日任务', tasks: ['1', '19', '31'].map(task_id => ({ state: 'finish', report_extra: { task_id } })) }] };
    },
    signState: async () => signs || options.alreadySigned ? signed : { state: 'ok', signed_date: 20753 },
    sign: async () => {
      signs++;
      if (options.failSign) throw new Error('private-sign-error');
      return { ...signed, pkey: 'private-key', popup: { data: { sign_in_coin: 100, plus_hcoin: false, description: 'private-description' } } };
    },
    web: async <T>(endpoint: string) => {
      assert.equal(endpoint, '/store/hcoin/history/'); historyReads++;
      if (options.failHistory) throw new Error('private-history-error');
      return { history: [
        { timestamp: '2026-10-27 01:00', event_desc: '完成签到任务', type: 'inc', value: 100 },
        { timestamp: '2026-10-28 01:00', event_desc: 'private-purchase', value: 300 },
        ...(signs && options.reward ? [{ timestamp: '2026-10-28 01:00', event_desc: '完成签到任务', type: 'inc', value: 100, secret: 'private-ledger' }] : []),
      ] } as T;
    },
    report: () => assert.fail('unexpected share'),
  };
  const run = () => runDaily(client, '12345', { now, sleep: async () => {}, log: () => {}, onSignDiagnostic: event => events.push(event) });
  return { run, events, signs: () => signs, historyReads: () => historyReads };
}

test('captures the first response and isolated sign balances without treating signed as paid', async () => {
  for (const reward of [true, false]) {
    const f = fixture({ reward }); const result = await f.run();
    const events = JSON.parse(JSON.stringify(f.events));
    assert.equal(result.completed, true);
    assert.equal(f.signs(), 1); assert.equal(f.historyReads(), 2);
    assert.deepEqual(events.map((e: { phase: string }) => e.phase), ['before', 'submitted', 'verified']);
    assert.equal(events[0].balance.coin, 20);
    assert.equal(events[0].history.entries.length, 0);
    assert.equal(events[1].response.state, 'ok');
    assert.equal(events[1].response.reward.sign_in_coin, 100);
    assert.equal(events[2].balance.coin, reward ? 120 : 20);
    assert.equal(events[2].history.entries.length, reward ? 1 : 0);
    assert.ok(!JSON.stringify(events).includes('private-'));
  }
});
test('history failure stays unknown and does not prevent sign or change task success', async () => {
  const f = fixture({ failHistory: true }); assert.equal((await f.run()).completed, true);
  const events = JSON.parse(JSON.stringify(f.events));
  assert.equal(events[0].history.status, 'unavailable');
  assert.equal(events[2].history.status, 'unavailable');
  assert.equal(f.signs(), 1); assert.ok(!JSON.stringify(events).includes('private-'));
});
test('preserves the submission response when the subsequent balance read fails', async () => {
  const f = fixture({ failReadback: true }); await assert.rejects(f.run(), /private-readback/);
  const events = JSON.parse(JSON.stringify(f.events));
  assert.equal(events[1].phase, 'submitted'); assert.equal(events[1].response.state, 'ok');
  assert.equal(events.at(-1).phase, 'failed'); assert.equal(f.signs(), 1);
  assert.ok(!JSON.stringify(events).includes('private-'));
});
test('failed submission is recorded safely and never replayed', async () => {
  const f = fixture({ failSign: true }); await assert.rejects(f.run(), /private-sign-error/);
  const events = JSON.parse(JSON.stringify(f.events));
  assert.equal(events.at(-1).phase, 'failed'); assert.equal(f.signs(), 1);
  assert.ok(!JSON.stringify(events).includes('private-'));
});
test('already signed accounts do not trigger diagnostic requests', async () => {
  const f = fixture({ alreadySigned: true }); await f.run();
  assert.equal(f.signs(), 0); assert.equal(f.historyReads(), 0); assert.deepEqual(f.events, []);
});
test('history distinguishes malformed replies and bounded pages from an empty current-day ledger', async () => {
  for (const value of [{}, { history: [{ event_desc: '完成签到任务', timestamp: 'secret', type: 'inc', value: 100 }] }]) {
    const client = { web: async <T>() => value as T };
    assert.equal((await readSignHistory(client, now())).status, 'invalid');
  }
  const row = { timestamp: '2026-10-29 00:00', event_desc: '完成签到任务', type: 'inc', value: 88 };
  const client = { web: async <T>() => ({ history: Array(31).fill(row) }) as T };
  const result = await readSignHistory(client, Date.parse('2026-10-28T16:00:00Z'));
  assert.equal(result.date, '2026-10-29'); assert.equal(result.limited, true);
  assert.equal(result.scanned, 30); assert.equal(result.entries?.length, 30);
});
