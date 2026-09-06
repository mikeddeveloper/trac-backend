ALTER TABLE "jobs"
ADD COLUMN IF NOT EXISTS "cancellationReason" text;
