// Real local D1 row counters; never connects to production or the upstream service.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { Store } from '../../../packages/hosting/src/store.ts';

const require = createRequire(realpathSync(new URL('../node_modules/wrangler/package.json', import.meta.url)));
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const now = Date.parse('2026-10-31T00:30:00+08:00');
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("fixture"); } };',
  compatibilityDate: '2026-10-27', d1Databases: ['DB'] }));
try {
  const db = await mf.getD1Database('DB');
  const migrations = new URL('../../web/migrations/', import.meta.url);
  for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    for (const sql of readFileSync(new URL(file, migrations), 'utf8').split(';').filter(sql => sql.trim()))
      await db.prepare(sql).run();
  }
  const samples = [];
  function record(sql, result) {
    samples.push({ sql: sql.replace(/\s+/g, ' ').trim(), rowsRead: result.meta.rows_read, rowsWritten: result.meta.rows_written });
    return result;
  }
  class Query {
    constructor(sql) { this.sql = sql; this.statement = db.prepare(sql); }
    bind(...values) { this.statement = this.statement.bind(...values); return this; }
    async all() { return record(this.sql, await this.statement.all()); }
    async first() { return (await this.all()).results[0] ?? null; }
    async run() { return record(this.sql, await this.statement.run()); }
  }
  const adapter = { prepare: sql => new Query(sql), batch: async statements => {
    const results = await db.batch(statements.map(s => s.statement));
    return results.map((r, i) => record(statements[i].sql, r));
  } };
  const store = new Store(adapter, () => now);
  const reports = [];
  for (const size of [1600, 8000]) {
    await db.prepare('DELETE FROM jobs').run();
    await db.prepare('DELETE FROM hosting').run();
    await db.prepare('DELETE FROM user').run();
    await db.prepare('UPDATE daily_scheduler SET next_start_at=0,next_dispatch_at=0,cooldown_until=0').run();
    await db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${size})
      INSERT INTO user(id,name,email,created_at,updated_at)
      SELECT printf('%05d',i),'fixture',printf('%05d@test.invalid',i),${now},${now} FROM n`).run();
    await db.prepare(`INSERT INTO hosting(user_id,heybox_id,ciphertext,version,updated_at)
      SELECT id,id,'fixture','fixture-version',${now} FROM user`).run();
    await db.prepare(`INSERT INTO jobs(id,user_id,date,status,available_at,created_at,updated_at)
      SELECT 'job-'||id,id,'2026-10-31','queued',${now},${now},${now} FROM user`).run();
    samples.length = 0;
    const first = await store.reserveDispatch();
    assert.deepEqual(first.map(m => m.id), Array.from({ length: 32 }, (_, i) => `job-${String(i + 1).padStart(5, '0')}`));
    assert.deepEqual(first.map(m => m.delaySeconds), Array.from({ length: 32 }, (_, i) => i * 4));
    const initial = samples.splice(0);
    assert.deepEqual(await store.reserveDispatch(), []);
    const full = samples.splice(0);
    // A running task still counts once; an exactly expired queued reservation stops counting.
    assert.ok(await store.claimQueued(first[0]));
    await db.prepare('UPDATE jobs SET dispatch_until=? WHERE id=?').bind(now, first[31].id).run();
    const replacement = await store.reserveDispatch();
    assert.equal(replacement.length, 1);
    assert.equal(replacement[0].id, first[31].id);
    // Recovery must still run when the in-flight cap is full, for both past and future dates.
    await db.prepare("UPDATE jobs SET date='2026-10-30' WHERE id='job-00040'").run();
    await db.prepare("UPDATE jobs SET date='2026-11-01' WHERE id='job-00041'").run();
    assert.deepEqual(await store.reserveDispatch(), []);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='cancelled'").first()).n, 2);
    reports.push({ size, initial, full, initialReads: initial.reduce((n, s) => n + s.rowsRead, 0),
      fullReads: full.reduce((n, s) => n + s.rowsRead, 0) });
  }
  console.log(JSON.stringify(reports, null, 2));
  for (const report of reports) {
    assert.ok(report.initialReads < 2000, `${report.size} queued: initial dispatch read ${report.initialReads} rows`);
    assert.ok(report.fullReads < 1000, `${report.size} queued: full cap read ${report.fullReads} rows`);
  }
} finally {
  await mf.dispose();
}
