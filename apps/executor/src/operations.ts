import { DailyTrace } from './daily-trace.ts';
import { HeyboxClient, HeyboxApiError } from 'heybox-daily/client';
import { runDaily, inspect, experienceDelta } from 'heybox-daily/tasks';
import { ActivityError, listActivities, participateActivity } from 'heybox-daily/activities';
import { createLoginConfig, sendLoginCode, verifyLoginCode } from 'heybox-daily/login-core';
import type { Inspection, TaskSnapshot as InspectionSnapshot } from 'heybox-daily/types';
import { taskIds, ActivityFailure, LoginFailure, LoginTiming, loginTimingHeader, type Job, type Outcome, type TaskSnapshot, type ActivityRequest, type ActivityResult } from '@heybox/contracts';
import { decryptCredential } from '@heybox/hosting/crypto';
import { createDailyCheckpoint } from '@heybox/hosting/checkpoint';
import { Store } from '@heybox/hosting/store';
import { deadline } from './deadline.ts';
import type { LoginOperations } from './challenge.ts';
import type { Env } from './env.ts';
import { sendWithCooldown } from './sms-send.ts';
import { ActivityTrace } from './activity-trace.ts';

export function failureCategory(error: unknown) {
  if (error instanceof HeyboxApiError && error.captchaRequired) return 'captcha_required';
  const text = error instanceof Error ? error.message : '';
  if (/频繁|次数.*限制|^HTTP 429：/.test(text)) return 'upstream_rate_limit';
  if (/^HTTP \d{3}：/.test(text)) return 'upstream_http';
  if (/请求失败或超时/.test(text)) return 'upstream_network';
  if (/接口未成功/.test(text)) return 'upstream_rejected';
  if (/验证码/.test(text)) return 'verification_code';
  if (/execution_timeout/.test(text)) return 'timeout';
  return 'internal';
}
function publicSnapshot(value: Inspection): TaskSnapshot {
  return { exp: value.exp, coin: value.coin, battery: value.battery, tasks: taskIds.map(id => ({ id,
    state: (id === 'sign' ? value.signed : value.tasks.find(task => task.id === id)?.state === 'finish') ? 'finish' : 'waiting' })) };
}
export async function executeDaily(job: Job, key: string, store: Pick<Store, 'heartbeat'>, fetchImpl: typeof fetch = fetch, options: { signDiagnostics?: boolean } = {}): Promise<Outcome & { category?: string }> {
  const scope = deadline(240_000, fetchImpl);
  const trace = new DailyTrace(job);
  try {
    const config = decryptCredential(job.credential, key);
    const client = new HeyboxClient(config, { fetchImpl: scope.fetch });
    const check = createDailyCheckpoint(job.date, async () => {
      scope.signal.throwIfAborted();
      if (!await store.heartbeat(job.id, job.lease, job.credential.version)) throw new Error('cancelled');
    });
    let before: InspectionSnapshot | undefined;
    let latest: InspectionSnapshot | undefined;
    let expDelta: number | undefined;
    const execution: NonNullable<Outcome['execution']> = {};
    try {
      const result = await runDaily(client, config.session.heybox_id, { log: () => {}, checkpoint: check, sleep: scope.sleep,
        onSignDiagnostic: options.signDiagnostics
          ? diagnostic => console.log(JSON.stringify({ event: 'executor_sign_diagnostic', jobId: job.id, ...diagnostic })) : undefined,
        onSnapshot: (value, delta) => { before ||= value; latest = value; expDelta = delta; },
        onTask: (id, action) => { execution[id] = action; }, onStage: stage => { trace.stage = stage; } });
      await check(true);
      return { status: 'completed', expDelta: result.expDelta, coinDelta: result.coinDelta,
        batteryDelta: result.batteryDelta, execution, profile: result.snapshot.profile, snapshot: publicSnapshot(result.snapshot) };
    } catch (error) {
      const text = error instanceof Error ? error.message : '';
      if (text === 'cancelled' || text === 'cross_day') return { status: 'cancelled', reason: text, execution };
      const failure = trace.fail(error, scope.signal.aborted);
      if (failure.category === 'auth') return { status: 'auth_expired', reason: 'auth_expired', execution, failure, errors: trace.errors };
      // No write was attempted: another immediate observation only repeats the failing request.
      if (!Object.values(execution).includes('executed'))
        return { status: 'failed', reason: scope.signal.aborted ? 'timeout' : 'upstream',
          category: failure.category, execution, failure, errors: trace.errors };
      let snapshot: TaskSnapshot | undefined;
      try {
        trace.stage = 'reconcile';
        await check(true);
        const state = await inspect(client, config.session.heybox_id);
        await check(true);
        const gain = latest && experienceDelta(latest, state);
        expDelta = expDelta === undefined || gain === undefined ? undefined : expDelta + gain;
        latest = state; snapshot = publicSnapshot(state);
      } catch (observationError) {
        const observationFailure = trace.fail(observationError, scope.signal.aborted);
        const stop = observationError instanceof Error ? observationError.message : '';
        if (stop === 'cancelled' || stop === 'cross_day') return { status: 'cancelled', reason: stop, execution, failure, errors: trace.errors };
        if (observationFailure.category === 'auth') return { status: 'auth_expired', reason: 'auth_expired', execution,
          uncertain: true, failure: observationFailure, errors: trace.errors };
      }
      const confirmed = snapshot?.tasks.every(task => task.state === 'finish');
      // An ambiguous write can be confirmed by a fresh read; its reward remains unknown.
      if (confirmed) return { status: 'completed', snapshot, execution, uncertain: true, failure, errors: trace.errors };
      return { status: 'failed', reason: scope.signal.aborted ? 'timeout' : 'upstream',
        category: failure.category, failure, errors: trace.errors, snapshot, execution, uncertain: !snapshot || undefined, expDelta: snapshot ? expDelta : undefined,
        coinDelta: snapshot && before && latest ? latest.coin - before.coin : undefined,
        batteryDelta: !snapshot || before?.battery === undefined || latest?.battery === undefined ? undefined : latest.battery - before.battery };
    }
  } finally { scope.close(); }
}
export async function executeActivity(input: ActivityRequest, key: string, store: Pick<Store, 'activityAccess'>, fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal, trace = new ActivityTrace(input)): Promise<ActivityResult> {
  const scope = deadline(90_000, fetchImpl, signal);
  try {
    trace.enter('credential');
    const config = decryptCredential(input.credential, key);
    const upstream = new HeyboxClient(config, { fetchImpl: scope.fetch });
    const client = {
      web: ((endpoint, ...args) => trace.upstream(endpoint, () => upstream.web(endpoint, ...args))) as typeof upstream.web,
      report: ((...args) => trace.upstream('/account/data_report/', () => upstream.report(...args))) as typeof upstream.report,
    };
    const check = async () => {
      scope.signal.throwIfAborted();
      if (!await store.activityAccess(input.credential.account, input.credential.version)) throw new ActivityError('activity_auth');
    };
    await check();
    const onStage = (stage: string) => trace.enter(stage);
    const result: ActivityResult = input.mode === 'list'
      ? { mode: 'list', activities: await listActivities(client, config.session.heybox_id, { onStage }) }
      : { mode: 'participate', activity: await participateActivity(client, config.session.heybox_id,
        input.activityId, input.approvedFollowIds, { checkpoint: check, sleep: scope.sleep, onStage }) };
    trace.enter('complete');
    trace.log('executor_activity_completed', { stages: trace.stages });
    return result;
  } catch (error) {
    const text = error instanceof Error ? error.message : '';
    const failure = new ActivityFailure(error instanceof ActivityError ? error.code
      : /登录已过期|登录已失效|设备令牌无效/.test(text) ? 'activity_auth' : 'activity_upstream');
    trace.enter(trace.stage);
    trace.log('executor_activity_failed', { code: failure.code, category: signal?.aborted ? 'cancelled'
      : scope.signal.aborted ? 'timeout' : error instanceof ActivityError ? 'business' : failureCategory(error), stages: trace.stages });
    throw failure;
  } finally { scope.close(); }
}
export async function requestDeviceToken(env: Pick<Env, 'TOKEN_SERVICE_URL' | 'TOKEN_SERVICE_TOKEN'>,
  timing: LoginTiming, request: typeof fetch = fetch): Promise<string> {
  const url = new URL('/token', env.TOKEN_SERVICE_URL);
  if (url.protocol !== 'https:' || env.TOKEN_SERVICE_TOKEN.length < 32) throw new Error('Invalid token service configuration');
  return timing.measure('token_http', async () => {
    const response = await request(url, { method: 'POST', redirect: 'manual',
      headers: { authorization: `Bearer ${env.TOKEN_SERVICE_TOKEN}`, 'content-type': 'application/json',
        [loginTimingHeader]: timing.id }, body: '{}' });
    timing.merge(response.headers.get('server-timing'));
    if (!response.ok) throw new Error('设备令牌服务暂时繁忙');
    const result = await response.json() as { token?: string };
    if (typeof result.token !== 'string' || !/^B[A-Za-z0-9+/=_-]{88}$/.test(result.token)) throw new Error('设备令牌格式无效');
    return result.token;
  });
}

export function loginOperations(env: Pick<Env, 'TOKEN_SERVICE_URL' | 'TOKEN_SERVICE_TOKEN' | 'CREDENTIAL_KEY' | 'DB'>, fetchImpl: typeof fetch = fetch): LoginOperations {
  const operation = async <T>(action: (request: typeof fetch) => Promise<T>): Promise<T> => {
    const scope = deadline(120_000, fetchImpl);
    try { return await action(scope.fetch); }
    catch (error) {
      if (failureCategory(error) === 'upstream_rate_limit') throw new LoginFailure('upstream_rate_limit');
      throw error;
    } finally { scope.close(); }
  };
  const step = async (action: 'send' | 'verify', request: typeof fetch, config: Parameters<LoginOperations['send']>[0], phone: string,
    timing: LoginTiming, proof?: Parameters<LoginOperations['send']>[2], code?: string) => {
    const options = { clientFactory: (value: typeof config) => new HeyboxClient(value, { fetchImpl: request }), captcha: proof };
    try {
      if (action === 'verify') return { status: 'authenticated' as const,
        config: await timing.measure('verify_upstream', () => verifyLoginCode(config, phone, code!, options)) };
      await timing.measure('sms_upstream', () => sendLoginCode(config, phone, options));
      return { status: 'sent' as const, config };
    } catch (error) {
      if (error instanceof HeyboxApiError && error.captchaRequired && error.captchaAppId)
        return { status: 'captcha' as const, appId: error.captchaAppId, config };
      throw error;
    }
  };
  const send = (request: typeof fetch, config: Parameters<LoginOperations['send']>[0], phone: string,
    timing: LoginTiming, proof?: Parameters<LoginOperations['send']>[2]) =>
    sendWithCooldown(new Store(env.DB), env.CREDENTIAL_KEY, phone, () => step('send', request, config, phone, timing, proof));
  return {
    begin: (phone, timing = new LoginTiming(), preparedToken) => operation(async request => {
      const token = preparedToken ?? await requestDeviceToken(env, timing, request);
      return send(request, createLoginConfig(token), phone, timing);
    }),
    send: (config, phone, proof, timing = new LoginTiming()) => operation(request => send(request, config, phone, timing, proof)),
    verify: (config, phone, code, proof, timing = new LoginTiming()) => operation(request => step('verify', request, config, phone, timing, proof, code)),
  };
}
