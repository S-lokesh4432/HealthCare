import { Prescription, Prisma } from '@prisma/client';
import { clinicTimeToInstant, formatDateOnly } from '../lib/time';

/** Dose times by doses-per-day, so reminders land at plausible hours. */
const DOSE_TIMES: Record<number, string[]> = {
  1: ['08:00'],
  2: ['08:00', '20:00'],
  3: ['08:00', '14:00', '20:00'],
  4: ['08:00', '12:00', '16:00', '20:00'],
  5: ['08:00', '11:00', '14:00', '17:00', '20:00'],
  6: ['08:00', '11:00', '14:00', '17:00', '20:00', '22:00'],
};

export function doseTimesFor(frequencyPerDay: number): string[] {
  return DOSE_TIMES[frequencyPerDay] ?? DOSE_TIMES[3];
}

export function reminderTimestamps(
  frequencyPerDay: number,
  durationDays: number,
  visitDate: Date
): Date[] {
  const times = doseTimesFor(frequencyPerDay);
  const stamps: Date[] = [];

  for (let dayOffset = 1; dayOffset <= durationDays; dayOffset += 1) {
    const day = new Date(visitDate.getTime());
    day.setUTCDate(day.getUTCDate() + dayOffset);
    const dateString = formatDateOnly(day);

    for (const time of times) {
      stamps.push(clinicTimeToInstant(dateString, time));
    }
  }
  return stamps;
}

export async function scheduleRemindersForPrescription(
  tx: Prisma.TransactionClient,
  prescription: Prescription,
  patientId: string,
  visitDate: Date
): Promise<number> {
  const stamps = reminderTimestamps(
    prescription.frequencyPerDay,
    prescription.durationDays,
    visitDate
  );

  await tx.medicationReminder.createMany({
    data: stamps.map((scheduledAt) => ({
      prescriptionId: prescription.id,
      patientId,
      scheduledAt,
    })),
  });

  return stamps.length;
}
