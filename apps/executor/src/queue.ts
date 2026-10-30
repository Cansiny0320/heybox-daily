import { outcomeSchema, queueMessageSchema, type Job, type Outcome } from '@heybox/contracts';
import { Store } from '@heybox/hosting/store';
import { executeDaily } from './operations.ts';
import type { Env } from './env.ts';

export async function dispatchDue(env: Pick<Env, 'DB' | 'DAILY_QUEUE' | 'DAILY_ENABLED'>) {
  if (env.DAILY_ENABLED !== 'true') return 0;
  const store = new Store(env.DB);
  const messages = await store.reserveDispatch();
  if (messages.length) {
    await env.DAILY_QUEUE.sendBatch(messages.map(({ id, token, delaySeconds }) => ({ body: { id, token }, delaySeconds })));
    await store.markDispatched(messages[0].token);
  }
  const count = messages.length;
  if (count) console.log(JSON.stringify({ event: 'executor_dispatched', count }));
  return count;
}
export async function consume(batch: MessageBatch<unknown>, env: Env, execute: (job: Job, key: string, store: Store) => Promise<Outcome & { category?: string }> = (job, key, store) => executeDaily(job, key, store, fetch, { signDiagnostics: env.SIGN_DIAGNOSTICS === 'true' })) {
  const store = new Store(env.DB);
  for (const message of batch.messages) {
    const parsed = queueMessageSchema.safeParse(message.body);
    if (!parsed.success) { console.warn(JSON.stringify({ event: 'executor_invalid_message' })); message.ack(); continue; }
    const started = performance.now();
    try {
      if (env.DAILY_ENABLED !== 'true') {
        await store.deferQueued(parsed.data);
        message.ack(); continue;
      }
      if (batch.queue.endsWith('-dead')) {
        await store.deadLetter(parsed.data);
        console.warn(JSON.stringify({ event: 'executor_dead_letter', jobId: parsed.data.id }));
        message.ack(); continue;
      }
      const job = await store.claimQueued(parsed.data);
      if (!job) {
        if (store.nextStartAt !== null)
          await store.deferQueued(parsed.data, Math.max(0, store.nextStartAt - store.now()));
        message.ack();
        continue;
      }
      let result: Outcome & { category?: string };
      try { result = await execute(job, env.CREDENTIAL_KEY, store); }
      catch { result = { status: 'failed', reason: 'upstream', uncertain: true, failure: { category: 'internal', stage: 'execute', durationMs: Math.round(performance.now() - started) } }; }
      const outcome = outcomeSchema.parse(result);
      let accepted = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { accepted = await store.finish(job.id, job.lease, job.credential.version, outcome); break; }
        catch (error) {
          if (attempt === 2) throw error;
          await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        }
      }
      console.log(JSON.stringify({ event: 'executor_task_finished', jobId: job.id, attemptId: job.lease, outcome: outcome.status, failure: outcome.failure,
        category: result.category, accepted, nextRetryAt: accepted ? store.nextRetryAt : null,
        durationMs: Math.round(performance.now() - started) }));
      message.ack();
    } catch {
      console.warn(JSON.stringify({ event: 'executor_delivery_failed', jobId: parsed.data.id }));
      message.retry({ delaySeconds: 60 });
    }
  }
}
