import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import type { HeyboxClient } from './client.js';

export type ActivityClient = Pick<HeyboxClient, 'web' | 'report'>;
export interface ActivityTask {
  task_id?: number | string; task_key?: string; task_name?: string; finished?: boolean;
  jump_protocol?: string;
}
export interface ActivityHome {
  logined?: boolean; heybox_id?: number | string; joined?: boolean; baned?: boolean; my_ticket?: number;
  award_info?: { award_id?: number | string; award_name?: string; share_title?: string; status?: number;
    award_number?: number; award_end_time?: string };
  front_task?: ActivityTask[] | ActivityTask | null;
  task_list?: ActivityTask[];
}
export interface ActivityView {
  id: string; name: string; prizeCount: number | null; endTime: string | null;
  joined: boolean; tickets: number | null;
  status: 'available' | 'follow_required' | 'blocked' | 'joined' | 'completed' | 'ended';
  reason?: string;
  followAccounts: Array<{ id: string; name: string }>;
}
export type ActivityErrorCode = 'activity_blocked' | 'activity_changed' | 'activity_unconfirmed' | 'activity_invalid' | 'activity_auth';
const errorMessages: Record<ActivityErrorCode, string> = {
  activity_blocked: '尚未满足参与条件，请先在小黑盒完成所需任务',
  activity_changed: '活动条件已变化，请刷新后重新确认关注账号',
  activity_unconfirmed: '操作结果尚未确认，请刷新活动状态后再试',
  activity_invalid: '活动信息暂时不可用，请稍后刷新',
  activity_auth: '小黑盒登录已失效或账号已变化，请重新登录',
};
export class ActivityError extends Error {
  readonly code: ActivityErrorCode;
  constructor(code: ActivityErrorCode) { super(errorMessages[code]); this.code = code; }
}
const HOME = '/store/roll_room_v2/get_home_info';
const numericId = (value: unknown): string | undefined => /^(?:[1-9]\d{0,19})$/.test(String(value ?? '')) ? String(value) : undefined;
const shortText = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim().slice(0, 240) : undefined;
const follows = new Set(['focus_on', 'focus_on_homeowner']);
function frontTasks(home: ActivityHome): ActivityTask[] {
  const value = home.front_task;
  return Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
}
function tasks(home: ActivityHome) {
  return [...frontTasks(home), ...home.task_list!];
}
function decodeProtocol(value: string | undefined): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || value.length > 16_384 || !value.startsWith('heybox://')) return;
  try {
    let text = value.slice('heybox://'.length);
    for (let i = 0; i < 3 && !text.startsWith('{'); i++) text = decodeURIComponent(text);
    const result: unknown = JSON.parse(text);
    if (result && typeof result === 'object' && !Array.isArray(result)) return result as Record<string, unknown>;
  } catch { /* Unknown protocols are not executable. */ }
}
function followTarget(task: ActivityTask) {
  const protocol = decodeProtocol(task.jump_protocol);
  return protocol?.protocol_type === 'openUser' ? numericId(protocol.user_id) : undefined;
}
function shareTask(home: ActivityHome) { return home.task_list!.find(task => task.task_key === 'share_act'); }
async function loadHome(client: ActivityClient, account: string, id: string): Promise<ActivityHome> {
  if (!numericId(id)) throw new ActivityError('activity_invalid');
  const home = await client.web<ActivityHome>(HOME, { award_id: id });
  if (home?.logined !== true || String(home.heybox_id) !== account) throw new ActivityError('activity_auth');
  if (typeof home.joined !== 'boolean' || typeof home.baned !== 'boolean' || !Array.isArray(home.task_list)
      || home.task_list.some(task => !task || typeof task !== 'object')
      || !home.award_info || String(home.award_info.award_id) !== id || typeof home.award_info.status !== 'number'
      || !shortText(home.award_info.award_name)
      || (home.front_task != null && typeof home.front_task !== 'object')
      || frontTasks(home).some(task => !task || typeof task !== 'object')) throw new ActivityError('activity_invalid');
  return home;
}
function viewOf(home: ActivityHome): ActivityView {
  const info = home.award_info!;
  const pending = home.joined ? [] : frontTasks(home).filter(task => task.finished !== true);
  const followAccounts = [...new Map(pending.filter(task => follows.has(task.task_key ?? '') && followTarget(task))
    .map(task => [followTarget(task)!, { id: followTarget(task)!, name: shortText(task.task_name) || '活动要求的账号' }])).values()];
  let status: ActivityView['status']; let reason: string | undefined;
  if (info.status !== 0) status = 'ended';
  else if (home.baned) { status = 'blocked'; reason = '小黑盒暂未开放此账号参与'; }
  else if (home.joined) status = shareTask(home) && shareTask(home)!.finished !== true ? 'joined' : 'completed';
  else if (pending.some(task => !follows.has(task.task_key ?? '') || !followTarget(task) || !numericId(task.task_id))) {
    status = 'blocked';
    reason = pending.map(task => shortText(task.task_name) || '需在小黑盒完成前置任务').join('；').slice(0, 500);
  } else status = pending.length ? 'follow_required' : 'available';
  const count = info.award_number;
  return {
    id: String(info.award_id), name: shortText(info.share_title) || shortText(info.award_name)!,
    prizeCount: Number.isSafeInteger(count) && count! >= 0 ? count! : null,
    endTime: shortText(info.award_end_time) || null,
    joined: home.joined!, tickets: Number.isSafeInteger(home.my_ticket) && home.my_ticket! >= 0 ? home.my_ticket! : null,
    status, ...(reason && { reason }), followAccounts,
  };
}
export async function inspectActivity(client: ActivityClient, account: string, id: string): Promise<ActivityView> {
  return viewOf(await loadHome(client, account, id));
}
export async function listActivities(client: ActivityClient, account: string,
  { onStage = () => {} }: Pick<ActivityOptions, 'onStage'> = {}): Promise<ActivityView[]> {
  const ids = new Set<string>();
  // The service returns at most 15 rows even if a larger limit is requested.
  for (let page = 0; page < 10; page++) {
    onStage('list_rooms');
    const rows = await client.web<Array<{ award_id?: number | string; status?: number }>>('/store/roll_room_v2/room_list', { offset: String(page * 15), limit: '15' });
    if (!Array.isArray(rows)) throw new ActivityError('activity_invalid');
    for (const row of rows) {
      const id = numericId(row?.award_id);
      if (row?.status === 0 && id) ids.add(id);
    }
    if (rows.length < 15) break;
    if (ids.size > 30) throw new ActivityError('activity_invalid');
  }
  const ordered = [...ids];
  const result: ActivityView[] = new Array(ordered.length);
  let cursor = 0;
  let failure: { error: unknown } | undefined;
  async function readDetails() {
    while (!failure && cursor < ordered.length) {
      const index = cursor++;
      try {
        onStage('list_home');
        result[index] = await inspectActivity(client, account, ordered[index]);
      } catch (error) { failure ||= { error }; }
    }
  }
  // Drain both readers before releasing the activity lease, including on error/cancellation.
  await Promise.all(Array.from({ length: Math.min(2, ordered.length) }, readDetails));
  if (failure) throw failure.error;
  return result;
}
interface ActivityOptions {
  sleep?: (ms: number) => Promise<unknown>; now?: () => number; checkpoint?: () => Promise<void>;
  onStage?: (stage: string) => void;
}
export async function participateActivity(client: ActivityClient, account: string, id: string,
  approvedFollowIds: string[], { sleep = setTimeout, now = Date.now, checkpoint = async () => {}, onStage = () => {} }: ActivityOptions = {}): Promise<ActivityView> {
  onStage('load_home');
  await checkpoint();
  let home = await loadHome(client, account, id);
  const allowed = new Set(approvedFollowIds);
  function checkEligibility() {
    onStage('eligibility');
    const view = viewOf(home);
    if (view.status === 'blocked' || view.status === 'ended') throw new ActivityError('activity_blocked');
    if (view.followAccounts.some(target => !allowed.has(target.id))) throw new ActivityError('activity_changed');
    return view;
  }
  checkEligibility();
  async function confirm(predicate: (value: ActivityHome) => boolean) {
    for (const delay of [1000, 2000, 4000]) {
      await sleep(delay); await checkpoint(); home = await loadHome(client, account, id);
      if (predicate(home)) return;
    }
    throw new ActivityError('activity_unconfirmed');
  }
  const pending = frontTasks(home).filter(task => task.finished !== true);
  for (const task of home.joined ? [] : pending) {
    checkEligibility();
    if (home.joined || tasks(home).some(latest => String(latest.task_id) === String(task.task_id) && latest.finished === true)) continue;
    const target = followTarget(task)!;
    onStage('follow_profile');
    const profile = await client.web<{ account_detail?: { userid?: number | string; bbs_info?: { follow_status?: number } } }>(
      '/bbs/app/profile/user/profile', { userid: target });
    const followStatus = profile?.account_detail?.bbs_info?.follow_status;
    if (String(profile?.account_detail?.userid) !== target || ![0, 1, 2, 3].includes(followStatus!)) throw new ActivityError('activity_invalid');
    await checkpoint();
    onStage('follow_report');
    await client.web('/store/roll_room_v2/data_report', {}, { body: new URLSearchParams({ report_type: '1', task_type: task.task_key!, task_id: String(task.task_id) }) });
    if (followStatus === 0 || followStatus === 2) {
      await checkpoint();
      onStage('follow_submit');
      try {
        await client.web('/bbs/app/profile/follow/user', {}, { body: new URLSearchParams({ following_id: target }) });
      } catch { /* The response may have been lost after acceptance. Read back before doing anything else. */ }
    }
    onStage('follow_confirm');
    await confirm(value => value.joined === true || tasks(value).some(latest => String(latest.task_id) === String(task.task_id) && latest.finished === true));
  }
  if (!home.joined) {
    checkEligibility();
    if (frontTasks(home).some(task => task.finished !== true)) throw new ActivityError('activity_unconfirmed');
    await checkpoint();
    onStage('join_submit');
    try {
      await client.web('/store/roll_room_v2/join', { osType: 'web' }, { body: new URLSearchParams({ award_id: id }) });
    } catch { /* Never repeat a possibly accepted join request. */ }
    onStage('join_confirm');
    await confirm(value => value.joined === true);
  }
  const share = shareTask(home);
  if (share && share.finished !== true) {
    checkEligibility();
    onStage('share_validate');
    const protocol = decodeProtocol(share.jump_protocol);
    if (protocol?.act_id !== `_rollroomv2_${id}`) throw new ActivityError('activity_invalid');
    const sessionId = randomUUID();
    for (const action of ['show', 'tap', 'success'] as const) {
      onStage('share_' + action);
      await checkpoint();
      try {
        await client.report({ type: action === 'tap' ? '4' : '3', path: `/share/behavior/${action}`, time: String(Math.floor(now() / 1000)),
          addition: { src: 'web', act_id: protocol.act_id as string, web_url: `https://api.xiaoheihe.cn/store/roll_room_v2?award_id=${id}`,
            ...(action === 'show' ? {} : { plat: 'WechatSession' }) } }, sessionId);
      } catch { break; }
      if (action === 'tap') await sleep(2000);
    }
    onStage('share_confirm');
    await confirm(value => shareTask(value)?.finished === true);
  }
  return viewOf(home);
}
