import { HeyboxApiError, HeyboxRequestError } from 'heybox-daily/client';
import { dailyFailureSchema, type DailyFailure, type Job } from '@heybox/contracts';

export function dailyFailure(error: unknown, stage: string, durationMs: number): DailyFailure {
  const measured = error instanceof HeyboxRequestError || error instanceof HeyboxApiError ? error.durationMs : undefined;
  const base = { stage, durationMs: Math.max(0, Math.round(measured ?? durationMs)) };
  if (error instanceof HeyboxRequestError) return dailyFailureSchema.parse({ ...base,
    category: error.httpStatus === 429 ? 'rate_limit' : error.category,
    endpoint: error.endpoint, httpStatus: error.httpStatus, retryAfterMs: error.retryAfterMs });
  if (error instanceof HeyboxApiError) return dailyFailureSchema.parse({ ...base,
    category: error.captchaRequired ? 'captcha' : error.rateLimited ? 'rate_limit' : 'rejected',
    endpoint: error.endpoint, httpStatus: error.httpStatus, businessCode: error.status, retryAfterMs: error.retryAfterMs });
  const text = error instanceof Error ? error.message : '';
  return { ...base, category: /execution_timeout/.test(text) ? 'timeout'
    : /未确认|未结算|未通过复查|^最终状态未通过检查/.test(text) ? 'unconfirmed'
    : /登录已过期|登录态失效|设备令牌无效/.test(text) ? 'auth' : 'protocol' };
}

export class DailyTrace {
  stage = 'credential';
  started = performance.now();
  errors: DailyFailure[] = [];
  readonly job: Pick<Job, 'id' | 'lease' | 'date'>;
  constructor(job: Pick<Job, 'id' | 'lease' | 'date'>) { this.job = job; }
  fail(error: unknown, timeout = false) {
    const failure = timeout ? { category: 'timeout' as const, stage: this.stage, durationMs: Math.round(performance.now() - this.started) }
      : dailyFailure(error, this.stage, performance.now() - this.started);
    this.errors.push(failure);
    console.warn(JSON.stringify({ event: 'executor_daily_error', jobId: this.job.id,
      attemptId: this.job.lease, date: this.job.date, ...failure }));
    return failure;
  }
}
