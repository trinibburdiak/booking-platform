-- Seña: monto por turno y si el negocio la exige (réplica)
ALTER TABLE "bookings" ADD COLUMN "deposit_cents" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "business_replica" ADD COLUMN "requires_deposit" BOOLEAN NOT NULL DEFAULT false;
