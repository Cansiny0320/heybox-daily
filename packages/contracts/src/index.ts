import { z } from 'zod';
import { beijingDate, taskIds } from './daily-tasks.ts';
export { DAILY_ATTEMPT_LIMIT, beijingDate, publicReasons, taskIds, taskNames } from './daily-tasks.ts';
export { LoginTiming, loginTimingHeader, type LoginStage } from './login-timing.ts';

export const phoneSchema = z.string().trim().transform(value => /^1[3-9]\d{9}$/.test(value) ? `+86${value}` : value)
  .pipe(z.string().regex(/^\+[1-9]\d{7,14}$/, '请输入有效手机号，海外号码需包含国家或地区区号'));
export const codeSchema = z.string().regex(/^\d{4,8}$/, '验证码应为 4 至 8 位数字');
export const idSchema = z.string().uuid();
export const bindingSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const taskViewSchema = z.object({ id: z.enum(taskIds), state: z.enum(['waiting', 'finish']) });
export const taskExecutionSchema = z.partialRecord(z.enum(taskIds), z.enum(['executed', 'skipped']));
export const snapshotSchema = z.object({ tasks: z.array(taskViewSchema).length(4), exp: z.number(), coin: z.number(), battery: z.number().int().nonnegative().optional() });
export type TaskSnapshot = z.infer<typeof snapshotSchema>;
export const profileSchema = z.object({ nickname: z.string().min(1).max(80).optional(),
  avatar: z.url({ protocol: /^https$/ }).max(2048).optional() });
export const credentialSchema = z.object({ account: z.string().regex(/^\d{1,20}$/), version: idSchema,
  ciphertext: z.string().min(32).max(8192), profile: profileSchema.optional() });
export type Credential = z.infer<typeof credentialSchema>;
export const activityIdSchema = z.string().regex(/^[1-9]\d{0,19}$/);
export const activityViewSchema = z.object({
  id: activityIdSchema, name: z.string().min(1).max(240), prizeCount: z.number().int().nonnegative().nullable(),
  endTime: z.string().max(240).nullable(), joined: z.boolean(), tickets: z.number().int().nonnegative().nullable(),
  status: z.enum(['available', 'follow_required', 'blocked', 'joined', 'completed', 'ended']),
  reason: z.string().max(500).optional(),
  followAccounts: z.array(z.object({ id: activityIdSchema, name: z.string().min(1).max(240) })).max(20),
});
export type ActivityView = z.infer<typeof activityViewSchema>;
export const activityConsentSchema = z.object({ activityId: activityIdSchema, approvedFollowIds: z.array(activityIdSchema).max(20) });
export const activityRequestSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('list'), credential: credentialSchema }),
  activityConsentSchema.extend({ mode: z.literal('participate'), credential: credentialSchema }),
]);
export type ActivityRequest = z.infer<typeof activityRequestSchema>;
export const activityResultSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('list'), activities: z.array(activityViewSchema).max(30) }),
  z.object({ mode: z.literal('participate'), activity: activityViewSchema }),
]);
export type ActivityResult = z.infer<typeof activityResultSchema>;
export const activityAccessSchema = credentialSchema.pick({ account: true, version: true });
const activityFailureMessages = {
  activity_blocked: '尚未满足参与条件，请先在小黑盒完成所需任务',
  activity_changed: '活动条件已变化，请刷新后重新确认关注账号',
  activity_unconfirmed: '操作结果尚未确认，请刷新活动状态后再试',
  activity_invalid: '活动信息暂时不可用，请稍后刷新',
  activity_auth: '小黑盒登录已失效或账号已变化，请重新登录',
  activity_busy: '当前账号的活动操作正在执行，请稍后刷新',
  activity_capacity: '活动服务当前请求较多，请稍后重试',
  activity_upstream: '小黑盒暂时无法处理此活动，请稍后刷新状态',
};
export const activityFailureSchema = z.object({ code: z.enum(Object.keys(activityFailureMessages) as [keyof typeof activityFailureMessages, ...Array<keyof typeof activityFailureMessages>]) });
export class ActivityFailure extends Error {
  readonly code: keyof typeof activityFailureMessages;
  constructor(code: keyof typeof activityFailureMessages) { super(activityFailureMessages[code]); this.code = code; }
}
export const jobSchema = z.object({ id: idSchema, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lease: idSchema, credential: credentialSchema });
export type Job = z.infer<typeof jobSchema>;
export const queueMessageSchema = z.object({ id: idSchema, token: idSchema });
export type QueueMessage = z.infer<typeof queueMessageSchema>;
export const dailyFailureSchema = z.object({
  category: z.enum(['network', 'timeout', 'http', 'rate_limit', 'captcha', 'auth', 'protocol', 'rejected', 'unconfirmed', 'internal']),
  stage: z.string().regex(/^[a-z0-9_:-]{1,48}$/),
  endpoint: z.string().regex(/^\/[a-zA-Z0-9_/-]{1,120}$/).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  businessCode: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/).optional(),
  durationMs: z.number().int().nonnegative(),
  retryAfterMs: z.number().int().nonnegative().max(604800000).optional(),
});
export type DailyFailure = z.infer<typeof dailyFailureSchema>;
export const outcomeSchema = z.object({ status: z.enum(['completed', 'failed', 'auth_expired', 'cancelled']),
  uncertain: z.boolean().optional(),
  failure: dailyFailureSchema.optional(), errors: z.array(dailyFailureSchema).max(12).optional(),
  snapshot: snapshotSchema.optional(), expDelta: z.number().optional(), coinDelta: z.number().optional(),
  batteryDelta: z.number().int().optional(), execution: taskExecutionSchema.optional(),
  profile: profileSchema.optional(),
  reason: z.enum(['upstream', 'timeout', 'auth_expired', 'cancelled', 'cross_day']).optional() });
export type Outcome = z.infer<typeof outcomeSchema>;
export const beginSchema = z.object({ phone: phoneSchema, binding: bindingSchema });
export const verifySchema = z.object({ challenge: idSchema, code: codeSchema, binding: bindingSchema });
export const captchaAppIdSchema = z.string().regex(/^\d{1,32}$/);
export const captchaProofSchema = z.object({
  ticket: z.string().min(1).max(2048).refine(value => !/[^\x21-\x7e]/.test(value) && !/^trerror_/i.test(value)),
  randstr: z.string().min(1).max(256).refine(value => !/[^\x21-\x7e]/.test(value) && !/^trerror_/i.test(value)),
});
export type CaptchaProof = z.infer<typeof captchaProofSchema>;
export const completeCaptchaSchema = captchaProofSchema.extend({ challenge: idSchema, binding: bindingSchema });
export const confirmLoginSchema = z.object({ challenge: idSchema, binding: bindingSchema });
export const finishSchema = z.object({ id: idSchema, lease: idSchema, version: idSchema, result: outcomeSchema });
export const heartbeatSchema = z.object({ id: idSchema, lease: idSchema, version: idSchema });
export const sentResultSchema = z.object({ status: z.literal('sent'), challenge: idSchema, expiresAt: z.number(), retryAfter: z.number(), message: z.string().max(120).optional() });
export const captchaResultSchema = z.object({ status: z.literal('captcha'), challenge: idSchema, expiresAt: z.number(), appId: captchaAppIdSchema });
export const beginResultSchema = z.discriminatedUnion('status', [sentResultSchema, captchaResultSchema]);
export type LoginProgress = z.infer<typeof beginResultSchema>;
export const runnerLoginResultSchema = z.discriminatedUnion('status', [sentResultSchema, captchaResultSchema,
  z.object({ status: z.literal('authenticated'), credential: credentialSchema,
    recovery: z.object({ challenge: idSchema, expiresAt: z.number() }).optional() })]);
const loginFailureMessages = {
  captcha_required: '请先完成人机验证，再继续登录',
  upstream_rate_limit: '小黑盒验证码请求过于频繁，请稍后再试',
  sms_cooldown: '该手机号正在发送验证码或仍在冷却，请稍后再试',
};
export const loginFailureSchema = z.object({ code: z.enum(['captcha_required', 'upstream_rate_limit', 'sms_cooldown']), retryAt: z.number().optional() });
export class LoginFailure extends Error {
  readonly code: keyof typeof loginFailureMessages;
  readonly retryAt?: number;
  constructor(code: keyof typeof loginFailureMessages = 'captcha_required', retryAt?: number) {
    super(loginFailureMessages[code]); this.code = code; this.retryAt = retryAt;
  }
}

export function nextRunAt(now = Date.now()) {
  const today = Date.parse(`${beijingDate(now)}T00:30:00+08:00`);
  return today > now ? today : today + 86400_000;
}
