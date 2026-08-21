-- Run once against production before deploying this release.
-- Recreate the enum so the new values can also be used by the repair UPDATE
-- when the migration runner wraps this file in a transaction.
ALTER TABLE "jobs" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "jobs" ALTER COLUMN "status" TYPE text USING "status"::text;
DROP TYPE "jobs_status_enum";
CREATE TYPE "jobs_status_enum" AS ENUM ('pending', 'bidding', 'bid-selected', 'payment-pending', 'accepted', 'in-transit', 'delivered', 'cancelled');
ALTER TABLE "jobs" ALTER COLUMN "status" TYPE "jobs_status_enum" USING "status"::"jobs_status_enum";
ALTER TABLE "jobs" ALTER COLUMN "status" SET DEFAULT 'bidding';

ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "lastKnownLat" double precision;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "lastKnownLng" double precision;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "lastLocationAccuracy" double precision;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "lastLocationSpeed" double precision;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "lastLocationAt" timestamp;

CREATE INDEX IF NOT EXISTS "IDX_jobs_lastLocationAt" ON "jobs" ("lastLocationAt");

-- Repair previously accepted jobs that never received a successful escrow payment.
UPDATE "jobs" j
SET "status" = 'bid-selected'
WHERE j."status" = 'accepted'
  AND NOT EXISTS (
    SELECT 1 FROM "payments" p
    WHERE p."jobId" = j."id"
      AND p."type" = 'escrow'
      AND p."status" IN ('success', 'held', 'released')
  );
