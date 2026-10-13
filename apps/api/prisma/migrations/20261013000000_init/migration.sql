CREATE EXTENSION IF NOT EXISTS btree_gist;

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'STAFF');

-- CreateEnum
CREATE TYPE "ExceptionType" AS ENUM ('CLOSED', 'EXTRA_HOURS');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED', 'ATTENDED', 'NO_SHOW');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "user_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "role" "Role" NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("user_id","business_id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "businesses" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "address" TEXT,
    "cancellation_hours" INTEGER NOT NULL DEFAULT 24,
    "booking_window_days" INTEGER NOT NULL DEFAULT 30,
    "min_notice_minutes" INTEGER NOT NULL DEFAULT 120,
    "requires_deposit" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "professionals" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "user_id" UUID,
    "display_name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "professionals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "services" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "duration_min" INTEGER NOT NULL,
    "buffer_min" INTEGER NOT NULL DEFAULT 0,
    "price_cents" INTEGER NOT NULL,
    "deposit_cents" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "professional_services" (
    "professional_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,

    CONSTRAINT "professional_services_pkey" PRIMARY KEY ("professional_id","service_id")
);

-- CreateTable
CREATE TABLE "schedules" (
    "id" UUID NOT NULL,
    "professional_id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_time" VARCHAR(5) NOT NULL,
    "end_time" VARCHAR(5) NOT NULL,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_exceptions" (
    "id" UUID NOT NULL,
    "professional_id" UUID NOT NULL,
    "date" VARCHAR(10) NOT NULL,
    "start_time" VARCHAR(5),
    "end_time" VARCHAR(5),
    "type" "ExceptionType" NOT NULL,
    "reason" TEXT,

    CONSTRAINT "schedule_exceptions_pkey" PRIMARY KEY ("id")
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
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "memberships_business_id_idx" ON "memberships"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "businesses_slug_key" ON "businesses"("slug");

-- CreateIndex
CREATE INDEX "professionals_business_id_idx" ON "professionals"("business_id");

-- CreateIndex
CREATE INDEX "services_business_id_idx" ON "services"("business_id");

-- CreateIndex
CREATE INDEX "schedules_professional_id_idx" ON "schedules"("professional_id");

-- CreateIndex
CREATE INDEX "schedule_exceptions_professional_id_date_idx" ON "schedule_exceptions"("professional_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_cancel_token_key" ON "bookings"("cancel_token");

-- CreateIndex
CREATE INDEX "bookings_business_id_starts_at_idx" ON "bookings"("business_id", "starts_at");

-- CreateIndex
CREATE INDEX "bookings_client_id_starts_at_idx" ON "bookings"("client_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_client_id_idempotency_key_key" ON "bookings"("client_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professionals" ADD CONSTRAINT "professionals_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professional_services" ADD CONSTRAINT "professional_services_professional_id_fkey" FOREIGN KEY ("professional_id") REFERENCES "professionals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professional_services" ADD CONSTRAINT "professional_services_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_professional_id_fkey" FOREIGN KEY ("professional_id") REFERENCES "professionals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_exceptions" ADD CONSTRAINT "schedule_exceptions_professional_id_fkey" FOREIGN KEY ("professional_id") REFERENCES "professionals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_professional_id_fkey" FOREIGN KEY ("professional_id") REFERENCES "professionals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- La regla anti doble reserva vive en la base: dos turnos activos del mismo
-- profesional no pueden superponerse. Postgres rechaza el segundo INSERT/UPDATE
-- con SQLSTATE 23P01 (exclusion_violation), que la API traduce a 409 Conflict.
ALTER TABLE "bookings" ADD CONSTRAINT "no_overlap"
    EXCLUDE USING gist (
        "professional_id" WITH =,
        "period" WITH &&
    ) WHERE ("status" IN ('PENDING', 'CONFIRMED'));

ALTER TABLE "bookings" ADD CONSTRAINT "valid_period" CHECK ("starts_at" < "ends_at" AND "ends_at" <= "blocked_until");
ALTER TABLE "schedules" ADD CONSTRAINT "valid_weekday" CHECK ("weekday" BETWEEN 0 AND 6);
