import { retryDelay } from './retry.ts';
import {
  DAILY_ATTEMPT_LIMIT,
  beijingDate,
  nextRunAt,
  outcomeSchema,
  taskIds,
  type Credential,
  type Job,
  type Outcome,
  type QueueMessage,
} from "@heybox/contracts";

export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface Database {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<unknown>;
}
type JobRow = {
  id: string;
  user_id: string;
  date: string;
  status: string;
  attempts: number;
  version: string | null;
  lease: string | null;
  result: string | null;
  updated_at: number;
  available_at: number;
};

export const DAILY_START_INTERVAL_MS = 4000;
export const DAILY_DISPATCH_LIMIT = 32;

export class Store {
  readonly db: Database;
  readonly now: () => number;
  private retryAfterSeconds = 1800;
  nextRetryAt: number | null = null;
  nextStartAt: number | null = null;
  get retryAfter() {
    return this.retryAfterSeconds;
  }
  constructor(db: Database, now = Date.now) {
    this.db = db;
    this.now = now;
  }
  private sql(query: string, ...values: unknown[]) {
    return this.db.prepare(query).bind(...values);
  }
  async activityCredential(userId: string): Promise<Credential | null> {
    return this.sql(
      "SELECT heybox_id AS account,version,ciphertext FROM hosting WHERE user_id=? AND credential_state='valid'",
      userId,
    ).first<Credential>();
  }
  async activityAccess(account: string, version: string) {
    return Boolean(
      await this.sql(
        "SELECT user_id FROM hosting WHERE user_id=? AND heybox_id=? AND version=? AND credential_state='valid'",
        `heybox:${account}`,
        account,
        version,
      ).first(),
    );
  }
  async enroll(credential: Credential, receipt?: { challenge: string; expiresAt: number }) {
    const id = `heybox:${credential.account}`;
    const now = this.now();
    if (receipt && receipt.expiresAt <= now) throw new Error("登录结果已过期");
    const owner = crypto.randomUUID();
    const gate = receipt ? " AND EXISTS(SELECT 1 FROM login_receipts WHERE challenge=? AND owner=?)" : "";
    const gateValues = receipt ? [receipt.challenge, owner] : [];
    await this.db.batch([
      ...(receipt ? [this.sql(
        "INSERT OR IGNORE INTO login_receipts(challenge,account,version,owner,expires_at) VALUES(?,?,?,?,?)",
        receipt.challenge, credential.account, credential.version, owner, receipt.expiresAt,
      )] : []),
      this.sql(
        `INSERT INTO user(id,name,email,image,created_at,updated_at) SELECT ?,?,?,?,?,? WHERE 1=1${gate}
        ON CONFLICT(id) DO UPDATE SET name=COALESCE(?,user.name),image=COALESCE(?,user.image),updated_at=excluded.updated_at`,
        id,
        credential.profile?.nickname || `盒友 ${credential.account}`,
        `${credential.account}@heybox.invalid`,
        credential.profile?.avatar || null,
        now,
        now,
        ...gateValues,
        credential.profile?.nickname || null,
        credential.profile?.avatar || null,
      ),
      this.sql(
        `INSERT INTO hosting(user_id,heybox_id,ciphertext,version,enabled,credential_state,updated_at) SELECT ?,?,?,?,1,'valid',? WHERE 1=1${gate}
        ON CONFLICT(user_id) DO UPDATE SET ciphertext=excluded.ciphertext,version=excluded.version,enabled=1,credential_state='valid',updated_at=excluded.updated_at`,
        id,
        credential.account,
        credential.ciphertext,
        credential.version,
        now,
        ...gateValues,
      ),
      this.sql(
        `UPDATE jobs SET status='cancelled',updated_at=? WHERE user_id=? AND status IN ('queued','running')${gate}`,
        now,
        id,
        ...gateValues,
      ),
      ...this.enqueueStatements(id, true, now, gate, gateValues),
    ]);
    if (receipt) {
      const current = await this.sql(
        `SELECT h.version FROM hosting h JOIN login_receipts r ON h.heybox_id=r.account
         WHERE r.challenge=? AND r.version=? AND r.expires_at>?`,
        receipt.challenge, credential.version, now,
      ).first<{ version: string }>();
      if (current?.version !== credential.version) throw new Error("登录结果已失效或已被新的登录替代");
    }
    return id;
  }
  async enqueue(userId: string, retry = false) {
    await this.db.batch(this.enqueueStatements(userId, retry, this.now()));
  }
  private enqueueStatements(userId: string, retry: boolean, now: number, gate = "", gateValues: unknown[] = []) {
    const date = beijingDate(now);
    const insert = this.sql(
      `INSERT INTO jobs(id,user_id,date,status,available_at,created_at,updated_at)
      SELECT ?,user_id,?,'queued',?,?,? FROM hosting WHERE user_id=? AND enabled=1 AND credential_state='valid'${gate}
      ON CONFLICT(user_id,date) DO NOTHING`,
      crypto.randomUUID(),
      date,
      now,
      now,
      now,
      userId,
      ...gateValues,
    );
    const statements = [insert];
    if (retry)
      statements.push(
        this.sql(
          `UPDATE jobs SET status='queued',available_at=MAX(?,COALESCE(lease_until,0)),updated_at=?,
          queue_token=NULL,queue_published=0,dispatch_until=0
      WHERE user_id=? AND date=? AND attempts<${DAILY_ATTEMPT_LIMIT} AND status IN ('failed','cancelled','auth_expired')
      AND EXISTS(SELECT 1 FROM hosting WHERE user_id=? AND enabled=1 AND credential_state='valid')${gate}`,
          now,
          now,
          userId,
          date,
          userId,
          ...gateValues,
        ),
      );
    return statements;
  }
  async acquireSmsSend(key: string): Promise<{ token?: string; retryAt: number }> {
    const now = this.now();
    const token = crypto.randomUUID();
    const acquired = await this.sql(
      `INSERT INTO sms_sends(key,token,expires_at) VALUES(?,?,?)
       ON CONFLICT(key) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at
       WHERE sms_sends.expires_at<=? RETURNING token,expires_at AS retryAt`,
      key, token, now + 180_000, now,
    ).first<{ token: string; retryAt: number }>();
    if (acquired) return acquired;
    const held = await this.sql("SELECT expires_at AS retryAt FROM sms_sends WHERE key=?", key)
      .first<{ retryAt: number }>();
    return { retryAt: held?.retryAt ?? now };
  }
  async finishSmsSend(key: string, token: string, possiblySent: boolean) {
    await (possiblySent
      ? this.sql("UPDATE sms_sends SET expires_at=? WHERE key=? AND token=?", this.now() + 60_000, key, token)
      : this.sql("DELETE FROM sms_sends WHERE key=? AND token=?", key, token)).run();
  }
  async schedule() {
    const now = this.now();
    const date = beijingDate(now);
    if (now >= Date.parse(`${date}T00:30:00+08:00`)) {
      const created = await this.sql(
        `INSERT OR IGNORE INTO jobs(id,user_id,date,status,available_at,created_at,updated_at)
        SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
        user_id,?,'queued',?,?,? FROM hosting h WHERE enabled=1 AND credential_state='valid'
        AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.user_id=h.user_id AND j.date=?) RETURNING id`,
        date,
        now,
        now,
        now,
        date,
      ).all<{ id: string }>();
      return created.results.length;
    }
    return 0;
  }
  async cleanup() {
    const now = this.now();
    await this.db.batch([
      this.sql("DELETE FROM rate_limits WHERE expires_at<?", now),
      this.sql("DELETE FROM sms_sends WHERE expires_at<?", now),
      this.sql("DELETE FROM login_receipts WHERE expires_at<?", now),
      this.sql("DELETE FROM session WHERE expires_at<?", now),
      this.sql("DELETE FROM jobs WHERE updated_at<?", now - 30 * 86400_000),
    ]);
  }
  private async nextWorkAt() {
    const now = this.now();
    const date = beijingDate(now);
    const row = await this.sql(
      // Most claims have immediately available work. Stop at the first indexed candidate;
      // only calculate every pending deadline when all eligible work is delayed or leased.
      `SELECT COALESCE((
        SELECT ? FROM jobs j JOIN hosting h ON h.user_id=j.user_id
        WHERE j.status='queued' AND j.date=? AND j.available_at<=?
        AND h.enabled=1 AND h.credential_state='valid'
        AND NOT EXISTS(SELECT 1 FROM jobs other WHERE other.user_id=j.user_id AND other.lease_until>=?)
        ORDER BY j.available_at,j.created_at LIMIT 1
      ),(SELECT MIN(CASE WHEN j.date<>? THEN ?
        WHEN j.status='running' THEN COALESCE(j.lease_until+1,?)
        ELSE MAX(j.available_at,COALESCE((SELECT MAX(other.lease_until)+1 FROM jobs other
          WHERE other.user_id=j.user_id AND other.lease_until>=?),0)) END) AS due
      FROM jobs j JOIN hosting h ON h.user_id=j.user_id
      WHERE j.status IN ('queued','running') AND h.enabled=1 AND h.credential_state='valid')) AS due,
      (SELECT MAX(next_start_at,cooldown_until) FROM daily_scheduler WHERE id=1) AS next_start_at,
      (EXISTS(SELECT 1 FROM jobs WHERE status IN ('queued','running') AND date<?)
       OR EXISTS(SELECT 1 FROM jobs WHERE status IN ('queued','running') AND date>?)) AS needs_recovery`,
      now,
      date,
      now,
      now,
      date,
      now,
      now,
      now,
      date,
      date,
    ).first<{ due: number | null; next_start_at: number; needs_recovery: number }>();
    const midnight = Date.parse(`${beijingDate(now)}T00:00:00+08:00`) + 86400_000;
    const due = row?.needs_recovery ? now : Math.min(Math.max(row?.due ?? now + 1_800_000, row?.next_start_at ?? 0), midnight);
    this.retryAfterSeconds = Math.max(1, Math.min(1800, Math.ceil((due - now) / 1000)));
    return due;
  }
  private async recover() {
    const now = this.now();
    await this.db.batch([
      this.sql(`UPDATE job_attempts SET status='unknown',finished_at=?
        WHERE status='running' AND EXISTS(SELECT 1 FROM jobs j WHERE j.id=job_attempts.job_id
          AND (j.status<>'running' OR j.lease IS NOT job_attempts.id OR j.lease_until<? OR j.date<>?))`, now, now, beijingDate(now)),
      this.sql(
        `UPDATE jobs SET status='cancelled',updated_at=? WHERE id IN (
          SELECT id FROM jobs WHERE status IN ('queued','running') AND date<?
          UNION ALL
          SELECT id FROM jobs WHERE status IN ('queued','running') AND date>?
        )`,
        now,
        beijingDate(now),
        beijingDate(now),
      ),
      this.sql(
        `UPDATE jobs SET available_at=? + CASE WHEN attempts<=1 THEN 300000 WHEN attempts=2 THEN 1200000 WHEN attempts=3 THEN 3600000 ELSE 7200000 END
        + abs(random()%(CASE WHEN attempts<=1 THEN 300001 WHEN attempts=2 THEN 1200001 WHEN attempts=3 THEN 3600001 ELSE 7200001 END))
        WHERE status='running' AND lease_until<?`, now, now,
      ),
      this.sql(
        `UPDATE jobs SET status=CASE WHEN attempts<${DAILY_ATTEMPT_LIMIT} AND available_at<? THEN 'queued' ELSE 'failed' END,lease=NULL,lease_until=NULL,updated_at=?,
        queue_token=NULL,queue_published=0,dispatch_until=0,
        result=json_set(json_remove(COALESCE(result,'{"status":"failed","reason":"timeout"}'),
          '$.expDelta','$.coinDelta','$.batteryDelta','$.snapshot','$.errors'),'$.uncertain',json('true'),
          '$.status','failed','$.reason','timeout','$.failure',json_object('category','timeout','stage','lease_recovery','durationMs',MAX(0,?-updated_at)))
        WHERE status='running' AND lease_until<?`,
        Date.parse(`${beijingDate(now)}T00:00:00+08:00`) + 86400_000,
        now,
        now,
        now,
      ),
      this.sql(`UPDATE job_attempts SET retry_at=(SELECT CASE WHEN status='queued' THEN available_at END FROM jobs WHERE id=job_id),
        result=json_object('status','failed','reason','timeout','uncertain',json('true'),'failure',
          json_object('category','timeout','stage','lease_recovery','durationMs',MAX(0,?-started_at)))
        WHERE status='unknown' AND finished_at=? AND EXISTS(SELECT 1 FROM jobs WHERE id=job_id AND lease IS NULL)`, now, now),
    ]);
  }
  async reserveDispatch(limit = DAILY_DISPATCH_LIMIT): Promise<Array<QueueMessage & { delaySeconds: number }>> {
    const now = this.now();
    // Most cron ticks have no work. Keep lease/attempt recovery independent of cooldown.
    const work = await this.sql(`SELECT
      (EXISTS(SELECT 1 FROM jobs WHERE status IN ('queued','running') AND date<?)
       OR EXISTS(SELECT 1 FROM jobs WHERE status IN ('queued','running') AND date>?)
       OR EXISTS(SELECT 1 FROM jobs WHERE status='running' AND lease_until<?)
       OR EXISTS(SELECT 1 FROM job_attempts a JOIN jobs j ON j.id=a.job_id
         WHERE a.status='running' AND (j.status<>'running' OR j.lease IS NOT a.id))) AS recover,
      EXISTS(SELECT 1 FROM jobs j JOIN hosting h ON h.user_id=j.user_id
        WHERE j.status='queued' AND j.date=? AND j.available_at<=? AND j.dispatch_until<=?
        AND j.attempts<${DAILY_ATTEMPT_LIMIT} AND h.enabled=1 AND h.credential_state='valid'
        AND (SELECT cooldown_until FROM daily_scheduler WHERE id=1)<=?
        AND NOT EXISTS(SELECT 1 FROM jobs other WHERE other.user_id=j.user_id AND other.lease_until>=?)) AS ready`,
      beijingDate(now), beijingDate(now), now, beijingDate(now), now, now, now, now,
    ).first<{ recover: number; ready: number }>();
    if (!work?.recover && !work?.ready) return [];
    if (work?.recover) await this.recover();
    const token = crypto.randomUUID();
    await this.db.batch([this.sql(
      `WITH candidates AS MATERIALIZED (
        SELECT j.id,j.available_at,j.created_at FROM jobs j JOIN hosting h ON h.user_id=j.user_id
        WHERE j.status='queued' AND j.date=? AND j.queue_published IN (0,1) AND j.available_at<=?
        AND (SELECT cooldown_until FROM daily_scheduler WHERE id=1)<=?
        AND j.dispatch_until<=? AND j.attempts<${DAILY_ATTEMPT_LIMIT} AND h.enabled=1 AND h.credential_state='valid'
        AND NOT EXISTS(SELECT 1 FROM jobs other WHERE other.user_id=j.user_id AND other.lease_until>=?)
        ORDER BY j.available_at,j.created_at,j.id LIMIT MAX(0,MIN(?,${DAILY_DISPATCH_LIMIT}-(
          SELECT COUNT(*) FROM jobs WHERE date=? AND status='running'
        )-(
          SELECT COUNT(*) FROM jobs WHERE date=? AND status='queued'
            AND queue_token IS NOT NULL AND dispatch_until>?
        )))
      ), slots AS MATERIALIZED (
        SELECT id,MAX(?,(SELECT MAX(next_start_at,next_dispatch_at) FROM daily_scheduler WHERE id=1))
          +(ROW_NUMBER() OVER (ORDER BY available_at,created_at,id)-1)*${DAILY_START_INTERVAL_MS} AS at
        FROM candidates
      )
      UPDATE jobs SET queue_token=?,queue_published=0,
        dispatch_at=(SELECT at FROM slots WHERE slots.id=jobs.id),
        dispatch_until=(SELECT at+60000 FROM slots WHERE slots.id=jobs.id)
      WHERE id IN (SELECT id FROM slots)`,
      beijingDate(now),
      now,
      now,
      now,
      now,
      limit,
      beijingDate(now),
      beijingDate(now),
      now,
      now,
      token,
    ), this.sql(
      `UPDATE daily_scheduler SET next_dispatch_at=COALESCE(
        (SELECT MAX(dispatch_at)+${DAILY_START_INTERVAL_MS} FROM jobs WHERE queue_token=?),next_dispatch_at)
       WHERE id=1 AND EXISTS(SELECT 1 FROM jobs WHERE queue_token=?)`, token, token,
    )]);
    const rows = await this.sql(
      `SELECT id,queue_token AS token,MAX(0,CAST((dispatch_at-?+999)/1000 AS INTEGER)) AS delaySeconds
       FROM jobs WHERE queue_token=? ORDER BY dispatch_at,id`, now, token,
    ).all<QueueMessage & { delaySeconds: number }>();
    return rows.results;
  }
  async markDispatched(token: string) {
    // Delivery may have already claimed or finished the task. Never change that new state.
    // Reconcile an unclaimed message after one hour, including an exhausted dead-letter delivery.
    await this.sql(
      "UPDATE jobs SET queue_published=1,dispatch_until=MAX(?,dispatch_at+3600000) WHERE queue_token=? AND status='queued'",
      this.now() + 3600_000,
      token,
    ).run();
  }
  private async beginAttempt(statement: Statement, lease: string, now: number): Promise<JobRow | null> {
    await this.db.batch([statement, this.sql(
      `UPDATE daily_scheduler SET next_start_at=? WHERE id=1
       AND EXISTS(SELECT 1 FROM jobs WHERE lease=? AND status='running')`, now + DAILY_START_INTERVAL_MS, lease,
    ), this.sql(
      `INSERT INTO job_attempts(id,job_id,number,started_at,status)
       SELECT lease,id,attempts,updated_at,'running' FROM jobs WHERE lease=? AND status='running'`, lease)]);
    return this.sql("SELECT * FROM jobs WHERE lease=? AND status='running'", lease).first<JobRow>();
  }
  async claimQueued(message: QueueMessage): Promise<Job | null> {
    this.nextStartAt = null;
    const now = this.now();
    const lease = crypto.randomUUID();
    const row = await this.beginAttempt(this.sql(
      `UPDATE jobs SET status='running',attempts=attempts+1,lease=?,lease_until=?,updated_at=?,
      version=(SELECT version FROM hosting WHERE user_id=jobs.user_id)
      WHERE id=? AND queue_token=? AND status='queued' AND attempts<${DAILY_ATTEMPT_LIMIT} AND available_at<=? AND date=?
      AND dispatch_at<=? AND (SELECT MAX(next_start_at,cooldown_until) FROM daily_scheduler WHERE id=1)<=?
      AND EXISTS(SELECT 1 FROM hosting WHERE user_id=jobs.user_id AND enabled=1 AND credential_state='valid')
      AND NOT EXISTS(SELECT 1 FROM jobs other WHERE other.user_id=jobs.user_id AND other.lease_until>=?) RETURNING *`,
      lease,
      now + 300_000,
      now,
      message.id,
      message.token,
      now,
      beijingDate(now),
      now,
      now,
      now,
    ), lease, now);
    if (!row) {
      const waiting = await this.sql(
        `SELECT MAX(?,j.available_at,j.dispatch_at,(SELECT MAX(next_start_at,cooldown_until) FROM daily_scheduler WHERE id=1),
          COALESCE((SELECT MAX(other.lease_until)+1 FROM jobs other WHERE other.user_id=j.user_id AND other.lease_until>=?),0)) AS next_at
         FROM jobs j JOIN hosting h ON h.user_id=j.user_id
         WHERE j.id=? AND j.queue_token=? AND j.status='queued' AND j.attempts<${DAILY_ATTEMPT_LIMIT}
         AND j.date=? AND h.enabled=1 AND h.credential_state='valid'`,
        now + 1, now, message.id, message.token, beijingDate(now),
      ).first<{ next_at: number }>();
      this.nextStartAt = waiting?.next_at ?? null;
      return null;
    }
    const credential = await this.sql(
      "SELECT heybox_id AS account,version,ciphertext FROM hosting WHERE user_id=? AND version=? AND credential_state='valid'",
      row.user_id,
      row.version,
    ).first<Credential>();
    return credential ? { id: row.id, date: row.date, lease, credential } : null;
  }
  async deadLetter(message: QueueMessage) {
    // Transport retries are not business attempts, including a failed handback during a pause.
    // D1 still bounds actual execution to the daily budget; retry delivery with a short backoff.
    await this.deferQueued(message, 60_000);
  }
  async deferQueued(message: QueueMessage, delayMs = 0) {
    // The D1 job remains the durable source of work; an old delivery cannot reset a new one.
    await this.sql(
      `UPDATE jobs SET queue_token=NULL,queue_published=0,dispatch_until=?
       WHERE id=? AND queue_token=? AND status='queued'`,
      this.now() + delayMs,
      message.id,
      message.token,
    ).run();
  }
  async claim(): Promise<Job | null> {
    if ((await this.nextWorkAt()) > this.now()) return null;
    await this.recover();
    const now = this.now();
    const lease = crypto.randomUUID();
    const row = await this.beginAttempt(this.sql(
      `UPDATE jobs SET status='running',attempts=attempts+1,lease=?,lease_until=?,updated_at=?,
      version=(SELECT version FROM hosting WHERE user_id=jobs.user_id)
      WHERE id=(SELECT j.id FROM jobs j JOIN hosting h ON h.user_id=j.user_id
        WHERE j.status='queued' AND j.attempts<${DAILY_ATTEMPT_LIMIT} AND j.available_at<=? AND j.date=? AND h.enabled=1 AND h.credential_state='valid'
        AND NOT EXISTS(SELECT 1 FROM jobs other WHERE other.user_id=j.user_id AND other.lease_until>=?)
        ORDER BY j.available_at,j.created_at LIMIT 1)
      AND (SELECT MAX(next_start_at,cooldown_until) FROM daily_scheduler WHERE id=1)<=? RETURNING *`,
      lease,
      now + 300_000,
      now,
      now,
      beijingDate(now),
      now,
      now,
    ), lease, now);
    if (!row) {
      await this.nextWorkAt();
      return null;
    }
    const credential = await this.sql(
      "SELECT heybox_id AS account,version,ciphertext FROM hosting WHERE user_id=? AND version=? AND credential_state='valid'",
      row.user_id,
      row.version,
    ).first<Credential>();
    if (!credential) return null;
    return { id: row.id, date: row.date, lease, credential };
  }
  async heartbeat(id: string, lease: string, version: string) {
    const now = this.now();
    const active = await this.sql(
      `SELECT lease_until FROM jobs WHERE id=? AND lease=? AND version=? AND status='running' AND lease_until>=? AND date=?
      AND EXISTS(SELECT 1 FROM hosting WHERE user_id=jobs.user_id AND version=? AND credential_state='valid')`,
      id,
      lease,
      version,
      now,
      beijingDate(now),
      version,
    ).first<{ lease_until: number }>();
    if (!active) return false;
    if (active.lease_until - now >= 120_000) return true;
    // Recheck revocation atomically: a relogin or deletion may happen after the read.
    return !!(await this.sql(
      `UPDATE jobs SET lease_until=? WHERE id=? AND lease=? AND version=? AND status='running' AND lease_until>=? AND date=?
      AND EXISTS(SELECT 1 FROM hosting WHERE user_id=jobs.user_id AND version=? AND credential_state='valid') RETURNING id`,
      now + 300_000,
      id,
      lease,
      version,
      now,
      beijingDate(now),
      version,
    ).first());
  }
  async finish(id: string, lease: string, version: string, outcome: Outcome) {
    const now = this.now();
    if (outcome.status === 'completed' && (!outcome.snapshot || outcome.snapshot.tasks.length !== 4 ||
      taskIds.some(id => outcome.snapshot!.tasks.filter(t => t.id === id && t.state === 'finish').length !== 1))) {
      outcome = { status: 'failed', reason: 'upstream', uncertain: true,
        failure: { category: 'protocol', stage: 'verify', durationMs: 0 } };
    }
    // A revoked child acknowledges that it has stopped; its result cannot change the new credential or job outcome.
    const released = await this.sql(
      `UPDATE jobs SET lease=NULL,lease_until=NULL,available_at=MIN(available_at,?)
      WHERE id=? AND lease=? AND version=? AND status IN ('queued','cancelled') AND lease_until IS NOT NULL RETURNING id`,
      now,
      id,
      lease,
      version,
    ).first();
    if (released) return false;
    const previous = await this.sql(
      `SELECT result,attempts FROM jobs WHERE id=? AND lease=? AND version=? AND status='running'`,
      id,
      lease,
      version,
    ).first<{ result: string | null; attempts: number }>();
    if (!previous) return false;
    const limits = [outcome.failure, ...(outcome.errors || [])].filter(failure =>
      failure?.httpStatus === 429 && failure.endpoint !== undefined
      && (failure.endpoint === '/account/data_report/'
        || ['/task/', '/bbs/', '/game/'].some(prefix => failure.endpoint!.startsWith(prefix))));
    const rateLimit = limits.length > 0;
    const cooldownMs = Math.max(60_000, ...limits.map(failure => failure?.retryAfterMs ?? 0));
    const delay = retryDelay(outcome, previous.attempts);
    const retryAt = delay === null ? now : now + delay;
    const retryable = delay !== null && beijingDate(retryAt) === beijingDate(now);
    const old = previous?.result ? outcomeSchema.parse(JSON.parse(previous.result)) : null;
    const uncertain = outcome.uncertain || old?.uncertain || undefined;
    const execution =
      outcome.execution || old?.execution ? { ...old?.execution, ...outcome.execution } : undefined;
    if (execution) {
      for (const task of taskIds) {
        if (old?.execution?.[task] === "executed" || outcome.execution?.[task] === "executed")
          execution[task] = "executed";
        else if (
          uncertain || (old && old.execution?.[task] !== "skipped") ||
          outcome.execution?.[task] !== "skipped"
        )
          delete execution[task];
      }
    }
    const result = {
      ...outcome,
      uncertain,
      execution,
      batteryDelta:
        uncertain || outcome.batteryDelta === undefined || (old !== null && old.batteryDelta === undefined)
          ? undefined
          : outcome.batteryDelta + (old?.batteryDelta || 0),
      expDelta:
        uncertain || outcome.expDelta === undefined || (old !== null && old.expDelta === undefined)
          ? undefined
          : outcome.expDelta + (old?.expDelta || 0),
      coinDelta:
        uncertain || (outcome.coinDelta === undefined && old?.coinDelta === undefined)
          ? undefined
          : (outcome.coinDelta || 0) + (old?.coinDelta || 0),
    };
    // The result, attempt and account updates share one transaction and the same version fence.
    await this.db.batch([
      this.sql(
        `UPDATE jobs SET status=CASE WHEN ?=1 AND attempts<${DAILY_ATTEMPT_LIMIT}
        AND EXISTS(SELECT 1 FROM hosting WHERE user_id=jobs.user_id AND enabled=1) THEN 'queued' ELSE ? END,
        available_at=?,result=?,updated_at=?,lease_until=NULL,
        queue_token=NULL,queue_published=0,dispatch_until=0 WHERE id=? AND lease=? AND version=? AND status='running'
        AND lease_until>=? AND date=? AND EXISTS(SELECT 1 FROM hosting WHERE user_id=jobs.user_id AND version=? AND credential_state='valid')`,
        retryable ? 1 : 0,
        outcome.status,
        retryAt,
        JSON.stringify(result),
        now,
        id,
        lease,
        version,
        now,
        beijingDate(now),
        version,
      ),
      this.sql(`UPDATE job_attempts SET status=?,finished_at=?,result=?,
        retry_at=(SELECT CASE WHEN status='queued' THEN available_at END FROM jobs WHERE id=?)
        WHERE id=? AND status='running' AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND lease=? AND version=? AND updated_at=? AND status<>'running')`,
        outcome.status,now,JSON.stringify(outcome),id,lease,id,lease,version,now),
      ...(rateLimit ? [
        this.sql(`DELETE FROM daily_rate_limits WHERE observed_at<?`, now - 60_000),
        this.sql(`INSERT INTO daily_rate_limits(user_id,observed_at,retry_until)
          SELECT user_id,?,? FROM jobs WHERE id=? AND lease=? AND version=? AND updated_at=? AND status<>'running'
          ON CONFLICT(user_id) DO UPDATE SET observed_at=excluded.observed_at,retry_until=MAX(daily_rate_limits.retry_until,excluded.retry_until)`,
          now, now + cooldownMs, id, lease, version, now),
        this.sql(`UPDATE daily_scheduler SET cooldown_until=MAX(cooldown_until,
          COALESCE((SELECT MAX(retry_until) FROM daily_rate_limits WHERE observed_at>=?),0))
          WHERE id=1 AND (cooldown_until>? OR (SELECT COUNT(*) FROM daily_rate_limits WHERE observed_at>=?)>=2)
          AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND lease=? AND version=? AND updated_at=? AND status<>'running')`,
          now - 60_000, now, now - 60_000, id, lease, version, now),
      ] : []),
      this.sql(
        `UPDATE hosting SET enabled=0,credential_state='expired',updated_at=? WHERE version=? AND user_id=(
        SELECT user_id FROM jobs WHERE id=? AND lease=? AND version=? AND status='auth_expired' AND updated_at=?)`,
        now,
        version,
        id,
        lease,
        version,
        now,
      ),
      ...(outcome.profile
        ? [
            this.sql(
              `UPDATE user SET name=COALESCE(?,name),image=COALESCE(?,image),updated_at=? WHERE id=(
          SELECT user_id FROM jobs WHERE id=? AND lease=? AND version=? AND status='completed' AND updated_at=?)`,
              outcome.profile.nickname || null,
              outcome.profile.avatar || null,
              now,
              id,
              lease,
              version,
              now,
            ),
          ]
        : []),
    ]);
    const saved = await this.sql(
      "SELECT status,available_at FROM jobs WHERE id=? AND lease=? AND version=? AND updated_at=? AND status<>'running'",
      id,
      lease,
      version,
      now,
    ).first<{ status: string; available_at: number }>();
    this.nextRetryAt = saved?.status === 'queued' ? saved.available_at : null;
    return !!saved;
  }
  async setEnabled(userId: string, enabled: boolean) {
    const now = this.now();
    await this.db.batch([
      this.sql(
        `UPDATE hosting SET enabled=?,updated_at=? WHERE user_id=? AND credential_state='valid'`,
        enabled ? 1 : 0,
        now,
        userId,
      ),
      ...(enabled
        ? []
        : [
            this.sql(
              `UPDATE jobs SET status='cancelled',updated_at=? WHERE user_id=? AND status='queued'`,
              now,
              userId,
            ),
          ]),
    ]);
    if (enabled) await this.enqueue(userId, true);
  }
  async accountCount() {
    const row = await this.sql("SELECT COUNT(*) AS count FROM hosting").first<{ count: number }>();
    return row?.count ?? 0;
  }
  async deleteUser(userId: string) {
    await this.sql("DELETE FROM user WHERE id=?", userId).run();
  }
  async dashboard(userId: string, includeHistory = true) {
    const today = beijingDate(this.now());
    const [settings, rows] = await Promise.all([
      this.sql(
        `SELECT h.heybox_id AS account,h.enabled,h.credential_state AS credentialState,u.name AS nickname,u.image AS avatar
        FROM hosting h JOIN user u ON u.id=h.user_id WHERE h.user_id=?`,
        userId,
      ).first<{
        account: string;
        enabled: number;
        credentialState: string;
        nickname: string;
        avatar: string | null;
      }>(),
      this.sql(
        includeHistory
          ? "SELECT id,date,status,attempts,result,updated_at,available_at FROM jobs WHERE user_id=? ORDER BY date DESC LIMIT 15"
          : "SELECT id,date,status,attempts,result,updated_at,available_at FROM jobs WHERE user_id=? AND date=? LIMIT 1",
        userId,
        ...(includeHistory ? [] : [today]),
      ).all<JobRow>(),
    ]);
    if (!settings) return null;
    const history = rows.results.map((row) => ({
      id: row.id,
      date: row.date,
      status: row.status,
      attempts: row.attempts,
      updatedAt: row.updated_at,
      retryAt: row.status === "queued" && row.attempts > 0 ? row.available_at : null,
      result: row.result ? outcomeSchema.parse(JSON.parse(row.result)) : null,
    }));
    return {
      account: settings.account,
      nickname: settings.nickname,
      avatar: settings.avatar,
      enabled: !!settings.enabled,
      credentialState: settings.credentialState,
      nextRunAt: settings.enabled ? nextRunAt(this.now()) : null,
      today: history.find((row) => row.date === today) || null,
      history: includeHistory ? history : [],
    };
  }
  async history(userId: string) {
    const dashboard = await this.dashboard(userId);
    if (!dashboard) return null;
    return {
      account: dashboard.account,
      nickname: dashboard.nickname,
      avatar: dashboard.avatar,
      records: dashboard.history.map((row) => ({
        ...row,
        taskType: "daily" as const,
        taskName: "每日任务",
      })),
    };
  }
  async quotaStates(keys: string[]) {
    if (!keys.length) return [];
    return (
      await this.sql(
        `SELECT key,count,expires_at AS retryAt FROM rate_limits WHERE key IN (${keys.map(() => "?").join(",")}) AND expires_at>?`,
        ...keys,
        this.now(),
      ).all<{ key: string; count: number; retryAt: number }>()
    ).results;
  }
  async quota(key: string, limit: number, windowMs: number) {
    const now = this.now();
    return !!(await this.sql(
      `INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE
      SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,expires_at=CASE WHEN expires_at<=? THEN ? ELSE expires_at END
      WHERE expires_at<=? OR count<? RETURNING key`,
      key,
      now + windowMs,
      now,
      now,
      now + windowMs,
      now,
      limit,
    ).first());
  }
  async quotas(rules: ReadonlyArray<{ key: string; limit: number; windowMs: number }>) {
    if (!rules.length) return null;
    const now = this.now();
    // Distinct keys, in evaluation order. Snapshot admission before writing so a
    // rejected rule leaves all later counters untouched, just like quota() calls.
    const { results } = await this.sql(
      `WITH rules(position,key,max_count,window_ms) AS (VALUES ${rules.map((_, i) => `(${i},?,?,?)`).join(",")}),
      admission AS MATERIALIZED (
        SELECT rules.*,rate_limits.key IS NULL OR expires_at<=? OR count<max_count AS allowed
        FROM rules LEFT JOIN rate_limits ON rate_limits.key=rules.key
      )
      INSERT INTO rate_limits(key,count,expires_at)
      SELECT key,1,?+window_ms FROM admission
      WHERE position<COALESCE((SELECT MIN(position) FROM admission WHERE NOT allowed),?)
      ON CONFLICT(key) DO UPDATE SET
        count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,
        expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END
      RETURNING key`,
      ...rules.flatMap((rule) => [rule.key, rule.limit, rule.windowMs]),
      now,
      now,
      rules.length,
      now,
      now,
    ).all<{ key: string }>();
    const admitted = new Set(results.map((row) => row.key));
    const rejected = rules.findIndex((rule) => !admitted.has(rule.key));
    return rejected < 0 ? null : rejected;
  }
}
