CREATE EXTENSION IF NOT EXISTS btree_gist;

-- CreateEnum
CREATE TYPE "ExceptionType" AS ENUM ('CLOSED', 'EXTRA_HOURS');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED', 'ATTENDED', 'NO_SHOW');

-- CreateTable
CREATE TABLE "outbox" (
    "id" BIGSERIAL NOT NULL,
    "event_id" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "consumer" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("consumer","event_id")
);

-- CreateTable
CREATE TABLE "business_replica" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "address" TEXT,
    "cancellation_hours" INTEGER NOT NULL,
    "booking_window_days" INTEGER NOT NULL,
    "min_notice_minutes" INTEGER NOT NULL,

    CONSTRAINT "business_replica_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "professional_replica" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "user_id" UUID,
    "display_name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL,

    CONSTRAINT "professional_replica_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_replica" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "duration_min" INTEGER NOT NULL,
    "buffer_min" INTEGER NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "deposit_cents" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL,

    CONSTRAINT "service_replica_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "professional_service_replica" (
    "professional_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,

    CONSTRAINT "professional_service_replica_pkey" PRIMARY KEY ("professional_id","service_id")
);

-- CreateTable
CREATE TABLE "schedule_replica" (
    "id" UUID NOT NULL,
    "professional_id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_time" VARCHAR(5) NOT NULL,
    "end_time" VARCHAR(5) NOT NULL,

    CONSTRAINT "schedule_replica_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exception_replica" (
    "id" UUID NOT NULL,
    "professional_id" UUID NOT NULL,
    "date" VARCHAR(10) NOT NULL,
    "start_time" VARCHAR(5),
    "end_time" VARCHAR(5),
    "type" "ExceptionType" NOT NULL,

    CONSTRAINT "exception_replica_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_replica" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" TEXT,

    CONSTRAINT "client_replica_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "professional_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "blocked_until" TIMESTAMPTZ(3) NOT NULL,
    "period" tstzrange GENERATED ALWAYS AS (tstzrange("starts_at", "blocked_until", '[)')) STORED,
    "status" "BookingStatus" NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "cancel_token" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_event_id_key" ON "outbox"("event_id");

-- CreateIndex
CREATE INDEX "outbox_published_at_id_idx" ON "outbox"("published_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "business_replica_slug_key" ON "business_replica"("slug");

-- CreateIndex
CREATE INDEX "professional_replica_business_id_idx" ON "professional_replica"("business_id");

-- CreateIndex
CREATE INDEX "service_replica_business_id_idx" ON "service_replica"("business_id");

-- CreateIndex
CREATE INDEX "schedule_replica_professional_id_idx" ON "schedule_replica"("professional_id");

-- CreateIndex
CREATE INDEX "exception_replica_professional_id_date_idx" ON "exception_replica"("professional_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_cancel_token_key" ON "bookings"("cancel_token");

-- CreateIndex
CREATE INDEX "bookings_business_id_starts_at_idx" ON "bookings"("business_id", "starts_at");

-- CreateIndex
CREATE INDEX "bookings_client_id_starts_at_idx" ON "bookings"("client_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_client_id_idempotency_key_key" ON "bookings"("client_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "professional_replica" ADD CONSTRAINT "professional_replica_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business_replica"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_replica" ADD CONSTRAINT "service_replica_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business_replica"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professional_service_replica" ADD CONSTRAINT "professional_service_replica_professional_id_fkey" FOREIGN KEY ("professional_id") REFERENCES "professional_replica"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professional_service_replica" ADD CONSTRAINT "professional_service_replica_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "service_replica"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_replica" ADD CONSTRAINT "schedule_replica_professional_id_fkey" FOREIGN KEY ("professional_id") REFERENCES "professional_replica"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_replica" ADD CONSTRAINT "exception_replica_professional_id_fkey" FOREIGN KEY ("professional_id") REFERENCES "professional_replica"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business_replica"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_professional_id_fkey" FOREIGN KEY ("professional_id") REFERENCES "professional_replica"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "service_replica"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- La regla anti doble reserva vive en la base: dos turnos activos del mismo
-- profesional no pueden superponerse. Postgres rechaza el segundo INSERT/UPDATE
-- con SQLSTATE 23P01 (exclusion_violation), que la API traduce a 409 Conflict.
ALTER TABLE "bookings" ADD CONSTRAINT "no_overlap"
    EXCLUDE USING gist (
        "professional_id" WITH =,
        "period" WITH &&
    ) WHERE ("status" IN ('PENDING', 'CONFIRMED'));

ALTER TABLE "bookings" ADD CONSTRAINT "valid_period" CHECK ("starts_at" < "ends_at" AND "ends_at" <= "blocked_until");
