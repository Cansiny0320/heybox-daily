import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectActivity, listActivities, participateActivity, type ActivityClient, type ActivityHome } from '../dist/activities.js';
import type { ShareEvent } from '../dist/types.js';

const protocol = (value: object) => `heybox://${encodeURIComponent(JSON.stringify(value))}`;
const follow = { task_id: 10, task_key: 'focus_on', task_name: '关注一加手机', finished: false,
  jump_protocol: protocol({ protocol_type: 'openUser', user_id: 456 }) };
const game = { task_id: 11, task_key: 'own_game', task_name: 'Steam库内拥有《测试游戏》', finished: false };
const share = { task_id: 12, task_key: 'share_act', task_name: '分享活动', finished: false,
  jump_protocol: protocol({ protocol_type: 'share', act_id: '_rollroomv2_9' }) };
function fixture(front: typeof follow[] | typeof game[] = []) {
  const home: ActivityHome = { logined: true, heybox_id: '123', joined: false, baned: false,
    award_info: { award_id: 9, award_name: '测试活动', status: 0, award_number: 5, award_end_time: '2026-10-29 15:00' },
    front_task: structuredClone(front), task_list: structuredClone([...front, share]) };
  const writes: Array<{ path: string; body?: URLSearchParams }> = [];
  const events: ShareEvent[] = [];
  let followStatus = 0;
  const client: ActivityClient = {
    web: async <T>(path: string, _query?: Record<string, string>, options?: { body?: URLSearchParams }) => {
      if (options?.body) {
        writes.push({ path, body: options.body });
        if (path === '/bbs/app/profile/follow/user') {
          followStatus = 1;
          home.task_list!.find(t => t.task_key === 'focus_on')!.finished = true;
          home.front_task = []; // Upstream can enroll as soon as the prerequisite settles.
          home.joined = true; home.my_ticket = 600;
        } else if (path === '/store/roll_room_v2/join') { home.joined = true; home.my_ticket = 100; }
        return {} as T;
      }
      if (path === '/store/roll_room_v2/get_home_info') return structuredClone(home) as T;
      if (path === '/bbs/app/profile/user/profile') return { account_detail: { userid: 456, bbs_info: { follow_status: followStatus } } } as T;
      throw new Error(`Unexpected read ${path}`);
    },
    report: async event => {
      events.push(event);
      if (event.path === '/share/behavior/success') {
        home.task_list!.find(t => t.task_key === 'share_act')!.finished = true;
        home.my_ticket = (home.my_ticket ?? 0) + 100;
      }
    },
  };
  return { client, home, writes, events, followed: () => { followStatus = 1; } };
}
const options = { sleep: async () => {}, now: () => Date.parse('2026-10-27T12:00:00Z') };

test('current account game prerequisites block participation and all mutations', async () => {
  const f = fixture([game]);
  assert.equal((await inspectActivity(f.client, '123', '9')).status, 'blocked');
  await assert.rejects(participateActivity(f.client, '123', '9', [], options), /参与条件/);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.events, []);
});
test('unknown prerequisites are blocked even when the old script did not recognize their key', async () => {
  const f = fixture([{ ...game, task_key: 'new_requirement' }]);
  const view = await inspectActivity(f.client, '123', '9');
  assert.equal(view.status, 'blocked'); assert.match(view.reason!, /测试游戏/);
  await assert.rejects(participateActivity(f.client, '123', '9', [], options));
  assert.equal(f.writes.length, 0);
});
test('an owned game prerequisite enables participation; an optional follow does not become mandatory', async () => {
  const f = fixture([{ ...game, finished: true }]);
  f.home.task_list!.push({ ...follow, task_key: 'focus_on_homeowner' });
  assert.equal((await inspectActivity(f.client, '123', '9')).status, 'available');
  const result = await participateActivity(f.client, '123', '9', [], options);
  assert.equal(result.status, 'completed'); assert.equal(result.tickets, 200);
  assert.deepEqual(f.writes.map(w => w.path), ['/store/roll_room_v2/join']);
});
test('list inspection never writes and does not expose upstream private fields', async () => {
  const f = fixture([follow]);
  const view = await inspectActivity(f.client, '123', '9');
  assert.equal(view.status, 'follow_required');
  assert.deepEqual(view.followAccounts, [{ id: '456', name: '关注一加手机' }]);
  assert.ok(!JSON.stringify(view).includes('heybox://')); assert.equal(f.writes.length, 0);
});
test('a changed or unapproved follow target never causes an account follow', async () => {
  const f = fixture([follow]);
  for (const approved of [[], ['777']]) await assert.rejects(participateActivity(f.client, '123', '9', approved, options), /条件已变化|关注/);
  assert.equal(f.writes.length, 0);
});
test('follow prerequisites use Web requests and skip joining when upstream already enrolled the account', async () => {
  const f = fixture([follow]);
  const result = await participateActivity(f.client, '123', '9', ['456'], options);
  assert.equal(result.status, 'completed'); assert.equal(result.tickets, 700);
  assert.deepEqual(f.writes.map(w => w.path), ['/store/roll_room_v2/data_report', '/bbs/app/profile/follow/user']);
  assert.equal(f.writes[0].body!.get('task_id'), '10');
  assert.equal(f.writes[1].body!.get('following_id'), '456');
  assert.deepEqual(f.events.map(e => e.path), ['/share/behavior/show', '/share/behavior/tap', '/share/behavior/success']);
  assert.deepEqual(f.events[2].addition, { src: 'web', act_id: '_rollroomv2_9', web_url: 'https://api.xiaoheihe.cn/store/roll_room_v2?award_id=9', plat: 'WechatSession' });
});
test('an already followed account is never followed again when its activity state is stale', async () => {
  const f = fixture([follow]); f.followed();
  await assert.rejects(participateActivity(f.client, '123', '9', ['456'], options), /确认|生效/);
  assert.ok(!f.writes.some(w => w.path === '/bbs/app/profile/follow/user'));
  assert.ok(!f.writes.some(w => w.path === '/store/roll_room_v2/join'));
});
test('follow response success without a finished prerequisite must not proceed to join or share', async () => {
  const f = fixture([follow]);
  const web = f.client.web;
  f.client.web = async <T>(...args: Parameters<ActivityClient['web']>) => args[0] === '/bbs/app/profile/follow/user' ? {} as T : web<T>(...args);
  await assert.rejects(participateActivity(f.client, '123', '9', ['456'], options), /确认|生效/);
  assert.ok(!f.writes.some(w => w.path === '/store/roll_room_v2/join')); assert.equal(f.events.length, 0);
});
test('uncertain join outcomes are checked, never retried blindly, and may resume sharing after confirmed success', async () => {
  const f = fixture(); const web = f.client.web;
  f.client.web = async <T>(...args: Parameters<ActivityClient['web']>) => {
    const result = await web<T>(...args);
    if (args[0] === '/store/roll_room_v2/join') throw new Error('timeout after upstream accepted');
    return result;
  };
  const result = await participateActivity(f.client, '123', '9', [], options);
  assert.equal(result.joined, true); assert.equal(result.status, 'completed');
  assert.equal(f.writes.filter(w => w.path === '/store/roll_room_v2/join').length, 1);
});
test('a failed join with unchanged state cannot cause share reports', async () => {
  const f = fixture(); const web = f.client.web;
  f.client.web = async <T>(...args: Parameters<ActivityClient['web']>) => {
    if (args[0] === '/store/roll_room_v2/join') throw new Error('rejected');
    return web<T>(...args);
  };
  await assert.rejects(participateActivity(f.client, '123', '9', [], options), /确认/);
  assert.equal(f.events.length, 0);
});
test('joined and completed tasks remain skipped on repeated participation calls', async () => {
  const f = fixture();
  await participateActivity(f.client, '123', '9', [], options);
  const counts = [f.writes.length, f.events.length];
  const result = await participateActivity(f.client, '123', '9', [], options);
  assert.equal(result.tickets, 200); assert.deepEqual([f.writes.length, f.events.length], counts);
});
test('share HTTP success without settlement does not claim completion', async () => {
  const f = fixture(); f.home.joined = true; f.home.my_ticket = 100;
  f.client.report = async event => { f.events.push(event); };
  await assert.rejects(participateActivity(f.client, '123', '9', [], options), /确认/);
  assert.equal(f.events.length, 3); assert.equal(f.home.my_ticket, 100);
});
test('share protocol from another activity is rejected before any share report', async () => {
  const f = fixture(); f.home.joined = true; f.home.my_ticket = 100;
  f.home.task_list![0].jump_protocol = protocol({ act_id: '_rollroomv2_777' });
  await assert.rejects(participateActivity(f.client, '123', '9', [], options));
  assert.equal(f.events.length, 0);
});
test('expired, mismatched and ended activity responses cannot mutate an account', async () => {
  for (const change of [
    (h: ActivityHome) => { h.logined = false; },
    (h: ActivityHome) => { h.heybox_id = '777'; },
    (h: ActivityHome) => { h.award_info!.award_id = 888; },
    (h: ActivityHome) => { h.award_info!.status = 2; },
    (h: ActivityHome) => { h.baned = true; },
  ]) {
    const f = fixture(); change(f.home);
    await assert.rejects(participateActivity(f.client, '123', '9', [], options));
    assert.equal(f.writes.length, 0); assert.equal(f.events.length, 0);
  }
});
test('backend credentials are rechecked before each mutation and revoked operations stop', async () => {
  const f = fixture(); let checks = 0;
  await assert.rejects(participateActivity(f.client, '123', '9', [], { ...options,
    checkpoint: async () => { checks++; if (f.writes.length) throw new Error('revoked'); } }), /revoked/);
  assert.ok(checks >= 2); assert.equal(f.writes.length, 1); assert.equal(f.events.length, 0);
});
test('discovery follows the actual 15-row pagination, deduplicates active rooms, and excludes ended rooms', async () => {
  const f = fixture(); const calls: string[] = []; const web = f.client.web;
  f.client.web = async <T>(...args: Parameters<ActivityClient['web']>) => {
    if (args[0] !== '/store/roll_room_v2/room_list') return web<T>(...args);
    calls.push(args[1]!.offset);
    return (args[1]!.offset === '0' ? [{ award_id: 9, status: 0 }, ...Array.from({ length: 14 }, (_, i) => ({ award_id: 100 + i, status: 2 }))] : []) as T;
  };
  const list = await listActivities(f.client, '123');
  assert.deepEqual(list.map(v => v.id), ['9']); assert.deepEqual(calls, ['0', '15']);
  assert.equal(f.writes.length, 0);
});
test('a full history window does not hide the active rooms already discovered', async () => {
  const f = fixture(); let pages = 0; const web = f.client.web;
  f.client.web = async <T>(...args: Parameters<ActivityClient['web']>) => {
    if (args[0] !== '/store/roll_room_v2/room_list') return web<T>(...args);
    pages++;
    return Array.from({ length: 15 }, (_, i) => ({ award_id: i === 0 && pages === 1 ? 9 : 100 + pages * 15 + i, status: i === 0 && pages === 1 ? 0 : 2 })) as T;
  };
  assert.equal((await listActivities(f.client, '123'))[0].id, '9'); assert.equal(pages, 10);
});

test('activity details use two bounded readers, preserve list order and drain on failure', async () => {
  for (const fail of [false, true]) {
    const f = fixture();
    let active = 0, peak = 0, reads = 0;
    const client: ActivityClient = { ...f.client, web: async <T>(path: string, query?: Record<string, string>) => {
      if (path.endsWith('room_list')) return [9, 10, 11, 12].map(award_id => ({ award_id, status: 0 })) as T;
      active++; peak = Math.max(peak, active); reads++;
      try {
        await new Promise(resolve => setTimeout(resolve, query?.award_id === '9' ? 15 : 1));
        if (fail && query?.award_id === '10') throw new Error('upstream unavailable');
        return { ...f.home, award_info: { ...f.home.award_info, award_id: Number(query?.award_id) } } as T;
      } finally { active--; }
    } };
    if (fail) { await assert.rejects(listActivities(client, '123'), /upstream unavailable/); assert.equal(reads, 2); }
    else assert.deepEqual((await listActivities(client, '123')).map(row => row.id), ['9', '10', '11', '12']);
    assert.equal(peak, 2); assert.equal(active, 0, 'no upstream work outlives the list operation');
  }
});
