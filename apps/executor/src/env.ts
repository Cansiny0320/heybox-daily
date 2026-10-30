import type { QueueMessage } from '@heybox/contracts';

export interface Env {
  DB: D1Database;
  DAILY_QUEUE: Queue<QueueMessage>;
  LOGIN_CHALLENGES: DurableObjectNamespace;
  ACTIVITY_GATE: DurableObjectNamespace;
  ACTIVITY_READERS: DurableObjectNamespace;
  CREDENTIAL_KEY: string;
  RUNNER_SERVICE_TOKEN: string;
  TOKEN_SERVICE_URL: string;
  TOKEN_SERVICE_TOKEN: string;
  DAILY_ENABLED: string;
  SIGN_DIAGNOSTICS?: string;
  LOGIN_PREPARE_PARALLEL?: string;
}
