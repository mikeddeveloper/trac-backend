ALTER TABLE "jobs"
  ADD COLUMN IF NOT EXISTS "otpFailedAttempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "otpLockedUntil" timestamp NULL;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "sessionVersion" integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "IDX_jobs_transporter_status"
  ON "jobs" ("transporterId", "status");

CREATE INDEX IF NOT EXISTS "IDX_payments_job_type_status"
  ON "payments" ("jobId", "type", "status");
