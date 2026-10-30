import { createRequire } from 'node:module';
import { realpathSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { LoginTiming, loginTimingHeader } from '@heybox/contracts';

const require = createRequire(realpathSync(new URL('../node_modules/wrangler/package.json', import.meta.url)));
const { Miniflare, convertV4MiniflareOptions, Response } = require('miniflare');
const { build } = require('esbuild');
const token = 'runtime-service-fixture-'.repeat(3);
const key = Buffer.alloc(32, 7).toString('base64');
const directory = mkdtempSync(path.join(tmpdir(), 'heybox-executor-test-'));
const source = `
import worker from './src/worker.ts';
import { LoginChallenge as OriginalChallenge, ActivityGate } from './src/objects.ts';
export { ActivityReader } from './src/activity-reader.ts';
import { Store } from '@heybox/hosting/store';
import { encryptCredential } from '@heybox/hosting/crypto';
import { seal, unseal } from './src/sealed-state.ts';
export { ActivityGate };
export class LoginChallenge extends OriginalChallenge {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/test/storage') return Response.json({ values: [...await this.ctx.storage.list()], alarm: await this.ctx.storage.getAlarm() });
    if (path === '/test/expire') {
      const id = (await request.json()).challenge;
      const state = unseal(await this.ctx.storage.get('challenge'), this.env.CREDENTIAL_KEY, id);
      state.expiresAt = Date.now() - 1;
      await this.ctx.storage.put('challenge', seal(state, this.env.CREDENTIAL_KEY, id));
      this.challenge = undefined;
      await this.ctx.storage.setAlarm(Date.now() + 10);
      return new Response(null, { status: 204 });
    }
    return super.fetch(request);
  }
}
export default { ...worker, async fetch(request, env, ctx) {
  if (new URL(request.url).pathname === '/test/quotas') {
    return Response.json({ rejected: await new Store(env.DB).quotas(await request.json()) });
  }
  if (new URL(request.url).pathname === '/test/cooldown') {
    let now = Date.now() + 60000;
    const store = new Store(env.DB, () => now);
    for (const account of ['900001', '900002', '900003'])
      await store.enroll({ account, version: crypto.randomUUID(), ciphertext: 'x'.repeat(64) });
    const messages = await store.reserveDispatch();
    for (let i = 0; i < 2; i++) {
      const job = await store.claimQueued(messages[i]);
      if (!job) throw new Error('fixture should start before cooldown');
      await store.finish(job.id, job.lease, job.credential.version, { status: 'failed',
        failure: { category: 'rate_limit', httpStatus: 429, endpoint: '/task/list_v2/', stage: 'inspect', durationMs: 1, retryAfterMs: 120000 } });
      now += 4000;
    }
    const blocked = await store.claimQueued(messages[2]);
    const resume = store.nextStartAt;
    const during = await store.reserveDispatch();
    await store.deferQueued(messages[2], resume - now);
    now = resume;
    const replacements = await store.reserveDispatch();
    const resumed = replacements.length ? await store.claimQueued(replacements[0]) : null;
    return Response.json({ blocked: blocked === null, pausedDispatches: during.length,
      resumed: !!resumed, attempts: (await env.DB.prepare('SELECT SUM(attempts) n FROM jobs WHERE user_id IN (?,?,?)').bind('heybox:900001','heybox:900002','heybox:900003').first()).n });
  }
  if (new URL(request.url).pathname === '/test/seed') {
    const account = (await request.json()).account;
    const credential = encryptCredential({session:{heybox_id:account,pkey:'fixture-key',device_id:'fixture-device',x_xhh_tokenid:'B'+'a'.repeat(88)},device:{model:'test',osVersion:'17'},app:{version:'1.3.398',build:'1142',shaderVersion:'14'}}, env.CREDENTIAL_KEY);
    await new Store(env.DB).enroll(credential);
    return Response.json(credential);
  }
  return worker.fetch(request, env, ctx);
} };
`;
const compiled = await build({ stdin: { contents: source, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*', 'cloudflare:workers'] });
let upstreamRequests = 0;
let verificationCount = 0;
let holdVerification = false;
let holdActivity = false;
let activityStarted = false;
const releases = [];
let reports = 0;
let signed = false;
const completed = new Set();
const taskState = () => ({ user: { userid: '123', level_info: { exp: 100 + completed.size, coin: 200, level: 1, max_exp: 1000 } },
  task_list: [{ title: '每日任务', tasks: ['1', '19', '31'].map(id => ({ title: id, state: completed.has(id) ? 'finish' : 'waiting', report_extra: { task_id: id } })) }] });
const options = convertV4MiniflareOptions({ name: 'executor-test', modules: true, script: compiled.outputFiles[0].text,
  compatibilityDate: '2026-10-27', compatibilityFlags: ['nodejs_compat', 'enable_request_signal', 'request_signal_passthrough'], cf: false,
  bindings: { CREDENTIAL_KEY: key, RUNNER_SERVICE_TOKEN: token, TOKEN_SERVICE_URL: 'https://token.invalid', TOKEN_SERVICE_TOKEN: token, DAILY_ENABLED: 'true' },
  d1Databases: ['DB'],
  durableObjects: { LOGIN_CHALLENGES: { className: 'LoginChallenge', useSQLite: true }, ACTIVITY_GATE: { className: 'ActivityGate', useSQLite: true },
    ACTIVITY_READERS: { className: 'ActivityReader', useSQLite: true } },
  queueProducers: { DAILY_QUEUE: 'heybox-daily-tasks' }, queueConsumers: { 'heybox-daily-tasks': { maxBatchSize: 1, maxBatchTimeout: 0 } },
  outboundService: async request => {
    upstreamRequests++;
    const url = new URL(request.url);
    if (url.origin === 'https://token.invalid') {
      assert.equal(url.pathname, '/token'); assert.equal(await request.text(), '{}');
      assert.equal(request.headers.get('authorization'), `Bearer ${token}`);
      assert.match(request.headers.get(loginTimingHeader), /^[a-f0-9-]{36}$/);
      return Response.json({ token: 'B' + 'a'.repeat(88) }, { headers: { 'server-timing': 'token_queue;dur=0, token_generate;dur=12.3, token_service;dur=12.4' } });
    }
    assert.ok(['https://api.xiaoheihe.cn', 'https://data.xiaoheihe.cn'].includes(url.origin), 'all network calls are intercepted');
    assert.equal(request.headers.get('authorization'), null);
    assert.equal(request.headers.get(loginTimingHeader), null);
    const path = url.pathname;
    if (path === '/account/get_login_code/') {
      assert.ok(request.headers.get('cookie').includes('x_xhh_tokenid=B' + 'a'.repeat(88)), 'only the privately generated token is used');
      const body = new URLSearchParams(await request.text());
      assert.ok(body.get('phone_num').length > 100); assert.ok(!body.get('phone_num').includes('13800138000'));
      return Response.json({ status: 'ok', result: {} });
    }
    if (path === '/account/login_code/') {
      verificationCount++;
      if (holdVerification) await new Promise(resolve => releases.push(resolve));
      return Response.json({ status: 'ok', result: { profile: { heybox_id: '123' }, account_detail: { userid: '123' }, pkey: 'fixture-pkey' } });
    }
    let result;
    if (path === '/task/list_v2/') result = taskState();
    else if (path === '/task/sign_v4/get_sign_state') result = { state: signed ? 'ok' : 'waiting', signed_date: Math.floor((Date.now() / 1000 + 8 * 3600) / 86400) };
    else if (path === '/task/sign_v3/sign') { signed = true; result = {}; }
    else if (path === '/bbs/app/feeds') result = { links: [{ linkid: 1, h_src: 'fixture' }] };
    else if (path === '/game/all_recommend/v2') result = { appid: 10, h_src: 'fixture' };
    else if (path === '/bbs/app/link/game/comments') result = { links: [{ linkid: 11, userid: 12 }] };
    else if (path === '/game/comment/share_data/') result = { comment_detail: { linkid: 11 } };
    else if (path === '/account/data_report/') { completed.add(['1', '19', '31'][Math.floor(reports++ / 3)]); result = {}; }
    else if (path.endsWith('/room_list')) {
      if (holdActivity) { activityStarted = true; await new Promise(resolve => releases.push(resolve)); }
      result = [{ award_id: 1, status: 0 }];
    }
    else if (path.endsWith('/get_home_info')) result = { logined: true, heybox_id: '123', joined: false, baned: false, task_list: [], award_info: { award_id: 1, award_name: 'Fixture', status: 0 } };
    else throw new Error('Unexpected upstream path ' + path);
    return Response.json({ status: 'ok', result });
  } });
options.workers.push(...convertV4MiniflareOptions({ name: 'activity-caller', modules: true,
  compatibilityDate: '2026-10-27', compatibilityFlags: ['enable_request_signal', 'request_signal_passthrough'],
  serviceBindings: { EXECUTOR: 'executor-test' },
  script: `export default { async fetch(request, env) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200);
    try { return await env.EXECUTOR.fetch('https://executor/activities', { method: 'POST',
      headers: request.headers, body: await request.text(), signal: controller.signal }); }
    catch { return Response.json({ cancelled: true }); }
    finally { clearTimeout(timer); }
  } }` }).workers);
options.resourcePersistencePath = directory;
let runtime = new Miniflare(options);
const call = (path, body = {}, requestId = randomUUID()) => runtime.dispatchFetch(`https://executor.local${path}`, { method: 'POST',
  headers: { authorization: `Bearer ${token}`, [loginTimingHeader]: requestId }, body: JSON.stringify(body) });
async function until(check, message, timeout = 10_000) {
  const start = Date.now();
  while (!await check()) { if (Date.now() - start > timeout) throw new Error(message); await new Promise(r => setTimeout(r, 25)); }
}
try {
  assert.equal((await runtime.dispatchFetch('https://executor.local/health', { method: 'POST' })).status, 401);
  let db = await runtime.getD1Database('DB');
  for (const name of readdirSync(new URL('../../web/migrations/', import.meta.url)).filter(x => x.endsWith('.sql')).sort()) {
    const sql = readFileSync(new URL('../../web/migrations/' + name, import.meta.url), 'utf8').replace(/--[^\n]*/g, '');
    for (const statement of sql.split(';').map(x => x.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  const quotaRules = [
    { key: 'runtime-ip-minute', limit: 3, windowMs: 60_000 },
    { key: 'runtime-ip-day', limit: 30, windowMs: 86400_000 },
    { key: 'runtime-phone-minute', limit: 1, windowMs: 60_000 },
    { key: 'runtime-phone-day', limit: 6, windowMs: 86400_000 },
  ];
  const admissions = await Promise.all(Array.from({ length: 8 }, async () => (await (await call('/test/quotas', quotaRules)).json()).rejected));
  assert.equal(admissions.filter(value => value === null).length, 1);
  for (const [index, rule] of quotaRules.entries()) {
    assert.equal((await db.prepare('SELECT count FROM rate_limits WHERE key=?').bind(rule.key).first()).count, [3, 3, 1, 1][index]);
  }
  await db.prepare('UPDATE rate_limits SET expires_at=0 WHERE key IN (?,?)').bind(quotaRules[0].key, quotaRules[2].key).run();
  assert.equal((await (await call('/test/quotas', quotaRules)).json()).rejected, null);
  const binding = 'a'.repeat(64);
  let phoneSequence = 1;
  const begin = async () => {
    const timing = new LoginTiming();
    const response = await call('/login/begin', { phone: '13800138' + String(phoneSequence++).padStart(3, '0'), binding, token: 'B' + 'z'.repeat(88) }, timing.id);
    assert.equal(response.headers.get(loginTimingHeader), timing.id);
    timing.merge(response.headers.get('server-timing'));
    for (const stage of ['challenge_load', 'challenge_save', 'challenge_total', 'token_http', 'token_service', 'token_queue', 'token_generate', 'sms_upstream', 'challenge_prepare', 'login_prepare', 'challenge_begin'])
      assert.ok(timing.values[stage] >= 0, `missing ${stage}`);
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); assert.equal(value.status, 'sent'); return value;
  };
  // prepare creates no persistent state and must not contact either upstream service.
  const prepareId = randomUUID();
  const prepareNamespace = await runtime.getDurableObjectNamespace('LOGIN_CHALLENGES');
  const prepareStub = prepareNamespace.get(prepareNamespace.idFromName(prepareId));
  const beforePrepare = upstreamRequests;
  assert.equal((await prepareStub.fetch('https://challenge/prepare', { method: 'POST', body: JSON.stringify({ challenge: prepareId }) })).status, 200);
  assert.deepEqual(await (await prepareStub.fetch('https://challenge/test/storage')).json(), { values: [], alarm: null });
  assert.equal(upstreamRequests, beforePrepare);
  await runtime.dispose(); runtime = new Miniflare(options);
  const resumedNamespace = await runtime.getDurableObjectNamespace('LOGIN_CHALLENGES');
  const resumedStub = resumedNamespace.get(resumedNamespace.idFromName(prepareId));
  const resumedBegin = await resumedStub.fetch('https://challenge/begin', { method: 'POST',
    body: JSON.stringify({ challenge: prepareId, phone: '13800138000', binding, token: 'B' + 'a'.repeat(88) }) });
  assert.equal(resumedBegin.status, 200, 'begin works after eviction between prepare and begin');
  assert.equal(upstreamRequests, beforePrepare + 1, 'prepared token avoids a second token-service request');
  assert.equal((await resumedStub.fetch('https://challenge/begin', { method: 'POST',
    body: JSON.stringify({ challenge: prepareId, phone: '13800138000', binding, token: 'B' + 'a'.repeat(88) }) })).status, 400);
  assert.equal(upstreamRequests, beforePrepare + 1, 'duplicate begin cannot resend');
  const first = await begin();
  let namespace = await runtime.getDurableObjectNamespace('LOGIN_CHALLENGES');
  let stub = namespace.get(namespace.idFromName(first.challenge));
  const stored = await (await stub.fetch('https://challenge/test/storage')).json();
  assert.equal(stored.alarm, first.expiresAt);
  for (const secret of ['13800138000', binding, 'fixture-pkey']) assert.ok(!JSON.stringify(stored.values).includes(secret));
  await runtime.dispose(); runtime = new Miniflare(options);
  db = await runtime.getD1Database('DB');
  namespace = await runtime.getDurableObjectNamespace('LOGIN_CHALLENGES');
  stub = namespace.get(namespace.idFromName(first.challenge));
  const verified = await call('/login/verify', { challenge: first.challenge, code: '1234', binding });
  const authenticated = await verified.json();
  assert.equal(authenticated.status, 'authenticated');
  assert.deepEqual(await (await call('/login/verify', { challenge: first.challenge, code: '1234', binding })).json(), authenticated);
  assert.equal((await call('/login/confirm', { challenge: first.challenge, binding: 'b'.repeat(64) })).status, 400);
  assert.equal((await call('/login/confirm', { challenge: first.challenge, binding })).status, 200);
  assert.equal((await call('/login/verify', { challenge: first.challenge, code: '1234', binding })).status, 400);
  assert.equal((await (await stub.fetch('https://challenge/test/storage')).json()).values.length, 0);
  const challenges = await Promise.all(Array.from({ length: 8 }, begin));
  holdVerification = true;
  const pending = challenges.map(value => call('/login/verify', { challenge: value.challenge, code: '1234', binding }));
  await until(() => releases.length === 8, 'independent challenge verification was serialized');
  assert.equal((await call('/login/verify', { challenge: challenges[0].challenge, code: '1234', binding })).status, 400);
  releases.forEach(release => release()); holdVerification = false;
  assert.ok((await Promise.all(pending)).every(response => response.status === 200));
  assert.equal(verificationCount, 9);
  const expired = await begin();
  const expiredStub = namespace.get(namespace.idFromName(expired.challenge));
  await expiredStub.fetch('https://challenge/test/expire', { method: 'POST', body: JSON.stringify(expired) });
  await until(async () => (await (await expiredStub.fetch('https://challenge/test/storage')).json()).values.length === 0, 'alarm did not clear state');
  const gateNamespace = await runtime.getDurableObjectNamespace('ACTIVITY_GATE');
  const gate = gateNamespace.get(gateNamespace.idFromName('global'));
  const gateCall = async (action, body) => gate.fetch('https://gate/' + action, { method: 'POST', body: JSON.stringify(body) });
  const leases = await Promise.all([1, 2, 3, 4].map(async account => (await gateCall('acquire', { account: String(account) })).json()));
  assert.ok(leases.every(x => x.token));
  assert.equal((await (await gateCall('acquire', { account: '5' })).json()).token, null);
  await gateCall('release', { account: '1', token: 'wrong' });
  assert.equal((await (await gateCall('acquire', { account: '1' })).json()).token, null);
  await gateCall('release', { account: '1', token: leases[0].token });
  assert.ok((await (await gateCall('acquire', { account: '5' })).json()).token);
  // Separate fixture account avoids the locks held above.
  const credential = await (await call('/test/seed', { account: '123' })).json();
  const reads = gateNamespace.get(gateNamespace.idFromName('reads'));
  const readGateCall = (action, body) => reads.fetch('https://gate/' + action, { method: 'POST', body: JSON.stringify(body) });
  const readLeases = await Promise.all(Array.from({ length: 8 }, async (_, i) =>
    (await readGateCall('acquire', { account: String(1000 + i) })).json()));
  assert.ok(readLeases.every(x => x.token));
  assert.equal((await (await readGateCall('acquire', { account: '2000' })).json()).reason, 'capacity');
  for (const [i, lease] of readLeases.entries()) await readGateCall('release', { account: String(1000 + i), token: lease.token });
  // All four participation slots remain occupied; they cannot block a list read.
  const activities = await call('/activities', { mode: 'list', credential });
  assert.equal((await activities.json()).activities.length, 1);
  const requestsBeforeCachedRead = upstreamRequests;
  assert.equal((await call('/activities', { mode: 'list', credential })).status, 200);
  assert.equal(upstreamRequests, requestsBeforeCachedRead);
  const readers = await runtime.getDurableObjectNamespace('ACTIVITY_READERS');
  const reader = readers.get(readers.idFromName('123'));
  await reader.fetch('https://reader/invalidate', { method: 'POST', body: JSON.stringify(credential) });
  holdActivity = true;
  // Match production's web -> executor service-binding cancellation, without relying on the dev HTTP proxy.
  const caller = await runtime.getWorker('activity-caller');
  const cancelled = caller.fetch('https://caller/activities', { method: 'POST',
    headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ mode: 'list', credential }) });
  await until(() => activityStarted, 'activity did not start');
  assert.equal((await (await readGateCall('acquire', { account: '123' })).json()).reason, 'account');
  assert.equal((await (await cancelled).json()).cancelled, true);
  let recoveredToken;
  await until(async () => {
    recoveredToken = (await (await readGateCall('acquire', { account: '123' })).json()).token;
    return !!recoveredToken;
  }, 'cancelled request left its activity lease held', 2000);
  await readGateCall('release', { account: '123', token: recoveredToken });
  holdActivity = false; releases.splice(0).forEach(release => release());
  assert.equal((await call('/activities', { mode: 'list', credential })).status, 200);
  assert.equal((await call('/tasks/wake')).status, 204);
  await until(async () => (await db.prepare('SELECT status FROM jobs').first())?.status === 'running', 'queue job was not claimed');
  const delivery = await db.prepare('SELECT id,queue_token AS token FROM jobs').first();
  const producer = await runtime.getQueueProducer('DAILY_QUEUE');
  await producer.send(delivery);
  await until(async () => (await db.prepare('SELECT status FROM jobs').first())?.status === 'completed', 'queue job did not complete', 45_000);
  const job = await db.prepare('SELECT id,status,attempts,queue_token,result FROM jobs').first();
  assert.equal(job.attempts, 1); assert.equal(reports, 9);
  assert.ok(JSON.parse(job.result).snapshot.tasks.every(x => x.state === 'finish'));
  await producer.send(delivery);
  await new Promise(r => setTimeout(r, 300));
  assert.equal((await db.prepare('SELECT attempts FROM jobs').first()).attempts, 1); assert.equal(reports, 9);
  assert.deepEqual(await (await call('/test/cooldown')).json(),
    { blocked: true, pausedDispatches: 0, resumed: true, attempts: 3 });
  // The independent rollback switch retains the previous serial login contract.
  await runtime.dispose();
  runtime = new Miniflare({ ...options, workers: options.workers.map(worker => ({ ...worker,
    config: { ...worker.config, env: { ...worker.config.env, LOGIN_PREPARE_PARALLEL: { type: 'text', value: 'false' } } },
  })) });
  const serial = await call('/login/begin', { phone: '13800138999', binding });
  assert.equal(serial.status, 200);
  assert.equal((await serial.json()).status, 'sent');
  assert.match(serial.headers.get('server-timing'), /token_http;dur=/);
  assert.ok(!serial.headers.get('server-timing').includes('challenge_prepare'));
  console.log(JSON.stringify({ runtime: 'workerd', bundleBytes: compiled.outputFiles[0].contents.length, mockedUpstreamRequests: upstreamRequests,
    verified: ['parallel login preparation and rollback switch', 'prepare has no persistent or upstream effects', 'eviction between prepare and begin', 'public inputs cannot replace the private token', 'atomic ordered quotas under concurrent D1 requests', 'correlated login timings through Worker, DO and token service', 'login RSA and encrypted credentials', 'real SQLite DO restart and alarm cleanup', '8 simultaneous independent logins', 'single challenge exclusion', 'global activity limit and per-account lock', 'D1 outbox and real queue consumption', 'daily four-task observation', 'duplicate delivery ignored', 'durable HTTP 429 cooldown and deferred message recovery'], realUpstreamRequests: 0 }));
} finally { releases.forEach(release => release()); await runtime.dispose(); rmSync(directory, { recursive: true, force: true }); }
