-- Sole authority preventing double-booking. Application-level checks are UX only;
-- this index is what makes concurrent INSERTs for the same slot mutually exclusive.
-- CANCELLED/EXPIRED/COMPLETED/NO_SHOW rows are excluded so the slot frees up again.
CREATE UNIQUE INDEX "appointment_slot_unique"
ON "Appointment" ("doctorId", "date", "startTime")
WHERE "status" IN ('HELD', 'CONFIRMED');
