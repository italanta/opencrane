-- Migration 0008: BrokeredDevice registry for the OpenClaw connection kill-switch (CONN.4)

CREATE TABLE "brokered_devices" (
  "id"               TEXT NOT NULL,
  "tenant"           TEXT NOT NULL,
  "subject"          TEXT NOT NULL,
  "gateway_url"      TEXT NOT NULL,
  "device_id"        TEXT,
  "brokered_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_brokered_at" TIMESTAMP(3) NOT NULL,
  "revoked_at"       TIMESTAMP(3),
  CONSTRAINT "brokered_devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "brokered_devices_tenant_subject_key" ON "brokered_devices"("tenant", "subject");
CREATE INDEX "brokered_devices_tenant_idx" ON "brokered_devices"("tenant");

ALTER TABLE "brokered_devices"
  ADD CONSTRAINT "brokered_devices_tenant_fkey"
  FOREIGN KEY ("tenant") REFERENCES "tenants"("name") ON DELETE CASCADE ON UPDATE CASCADE;
