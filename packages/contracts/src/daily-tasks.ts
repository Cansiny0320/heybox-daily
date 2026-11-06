export const DAILY_ATTEMPT_LIMIT = 5;
export const taskIds = ['sign', '1', '19', '31'] as const;
export const taskNames = { sign: '每日签到', '1': '分享帖子', '19': '分享游戏', '31': '分享游戏评价' };

export function beijingDate(now = Date.now()) {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}

export const publicReasons = {
  upstream: '小黑盒接口暂时不可用',
  timeout: '本次执行超时',
  auth_expired: '小黑盒登录已失效，请重新登录',
  cancelled: '任务已停止',
  cross_day: '已跨日，等待今天的任务',
};
