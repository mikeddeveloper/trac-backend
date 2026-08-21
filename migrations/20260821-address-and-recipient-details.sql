ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "pickupNote" varchar;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "deliveryNote" varchar;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "recipientName" varchar;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "recipientPhone" varchar;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "pickupLat" double precision;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "pickupLng" double precision;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "deliveryLat" double precision;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "deliveryLng" double precision;
