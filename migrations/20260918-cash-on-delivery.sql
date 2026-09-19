DO $$ BEGIN
  CREATE TYPE "jobs_payment_method_enum" AS ENUM ('prepaid', 'cash-on-delivery');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "jobs"
  ADD COLUMN IF NOT EXISTS "paymentMethod" "jobs_payment_method_enum" NOT NULL DEFAULT 'prepaid',
  ADD COLUMN IF NOT EXISTS "bookingFee" numeric(15,2),
  ADD COLUMN IF NOT EXISTS "cashReceived" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "cashReceivedAt" timestamp;

CREATE INDEX IF NOT EXISTS "IDX_jobs_payment_method_status"
  ON "jobs" ("paymentMethod", "status");
