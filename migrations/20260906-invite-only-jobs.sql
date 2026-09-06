ALTER TABLE "jobs"
ADD COLUMN IF NOT EXISTS "invitedTransporterId" uuid NULL;

CREATE INDEX IF NOT EXISTS "IDX_jobs_invited_transporter"
ON "jobs" ("invitedTransporterId");
