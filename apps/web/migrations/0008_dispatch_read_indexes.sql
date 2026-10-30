-- Preserve deterministic dispatch order without sorting an entire tied batch.
DROP INDEX jobs_ready;
CREATE INDEX jobs_ready ON jobs(status,date,available_at,created_at,id);

-- Count only queued reservations, bounded by date and expiry, not the full backlog.
CREATE INDEX jobs_inflight_dispatch ON jobs(date,dispatch_until)
WHERE status='queued' AND queue_token IS NOT NULL;
