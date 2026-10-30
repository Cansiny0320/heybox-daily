import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, uniqueIndex, index, check } from "drizzle-orm/sqlite-core";

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
  },
  (t) => [index("session_user").on(t.userId)],
);
export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("account_user").on(t.userId)],
);
export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
export const hosting = sqliteTable("hosting", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  heyboxId: text("heybox_id").notNull().unique(),
  ciphertext: text("ciphertext").notNull(),
  version: text("version").notNull(),
  enabled: integer("enabled").notNull().default(1),
  credentialState: text("credential_state").notNull().default("valid"),
  updatedAt: integer("updated_at").notNull(),
});
export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    version: text("version"),
    lease: text("lease"),
    leaseUntil: integer("lease_until"),
    availableAt: integer("available_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    result: text("result"),
    queueToken: text("queue_token"),
    queuePublished: integer("queue_published").notNull().default(0),
    dispatchUntil: integer("dispatch_until").notNull().default(0),
    dispatchAt: integer("dispatch_at").notNull().default(0),
  },
  (t) => [
    uniqueIndex("jobs_user_day").on(t.userId, t.date),
    index("jobs_ready").on(t.status, t.date, t.availableAt, t.createdAt),
    index("jobs_dispatch").on(
      t.status,
      t.date,
      t.queuePublished,
      t.availableAt,
      t.createdAt,
      t.dispatchUntil,
    ),
    index("jobs_queue_token").on(t.queueToken),
    index("jobs_lease").on(t.lease),
  ],
);
export const dailyScheduler = sqliteTable(
  "daily_scheduler",
  {
    id: integer("id").primaryKey(),
    nextStartAt: integer("next_start_at").notNull().default(0),
    nextDispatchAt: integer("next_dispatch_at").notNull().default(0),
    cooldownUntil: integer("cooldown_until").notNull().default(0),
  },
  (t) => [check("daily_scheduler_singleton", sql`${t.id} = 1`)],
);
export const rateLimits = sqliteTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const jobAttempts = sqliteTable(
  "job_attempts",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    retryAt: integer("retry_at"),
    status: text("status").notNull(),
    result: text("result"),
  },
  (t) => [
    index("job_attempts_job").on(t.jobId, t.startedAt),
    index("job_attempts_state").on(t.status, t.finishedAt),
  ],
);

export const dailyRateLimits = sqliteTable(
  "daily_rate_limits",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    observedAt: integer("observed_at").notNull(),
    retryUntil: integer("retry_until").notNull(),
  },
  (t) => [index("daily_rate_limits_observed").on(t.observedAt)],
);
