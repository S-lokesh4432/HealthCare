import { AppointmentStatus, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { badRequest, conflict, notFound } from '../lib/errors';
import {
  clinicTimeToInstant,
  dayOfWeek,
  minutesToTime,
  parseDateOnly,
  timeToMinutes,
} from '../lib/time';

export const HOLD_DURATION_MINUTES = 7;

const SLOT_TAKEN_MESSAGE = 'This slot was just taken, please pick another.';

const SLOT_INDEX_FIELDS = ['doctorId', 'date', 'startTime'];

/**
 * Prisma surfaces the violated columns in meta.target, not the index name, so
 * the slot collision is identified by its field set.
 */
export function isSlotTakenError(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;

  const target = err.meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
  const joined = fields.join(',');

  return (
    joined.includes('appointment_slot_unique') ||
    SLOT_INDEX_FIELDS.every((field) => fields.includes(field))
  );
}

export async function holdSlot(params: {
  doctorId: string;
  patientId: string;
  date: string;
  startTime: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const date = parseDateOnly(params.date);

  const doctor = await prisma.doctorProfile.findUnique({
    where: { id: params.doctorId },
    select: { id: true, slotDurationMinutes: true },
  });
  if (!doctor) throw notFound('Doctor not found');

  if (clinicTimeToInstant(params.date, params.startTime).getTime() <= now.getTime()) {
    throw badRequest('That slot is in the past', 'SLOT_IN_PAST');
  }

  const leave = await prisma.leave.findUnique({
    where: { doctorId_date: { doctorId: doctor.id, date } },
  });
  if (leave) throw conflict('The doctor is on leave that day', 'DOCTOR_ON_LEAVE');

  const workingHour = await prisma.workingHour.findUnique({
    where: { doctorId_dayOfWeek: { doctorId: doctor.id, dayOfWeek: dayOfWeek(date) } },
  });
  if (!workingHour) throw badRequest('The doctor does not work that day', 'OUTSIDE_WORKING_HOURS');

  const startMinutes = timeToMinutes(params.startTime);
  const openMinutes = timeToMinutes(workingHour.startTime);
  const closeMinutes = timeToMinutes(workingHour.endTime);
  const endMinutes = startMinutes + doctor.slotDurationMinutes;

  const alignedToGrid = (startMinutes - openMinutes) % doctor.slotDurationMinutes === 0;
  if (startMinutes < openMinutes || endMinutes > closeMinutes || !alignedToGrid) {
    throw badRequest('That start time is not a valid slot for this doctor', 'INVALID_SLOT');
  }

  const holdExpiresAt = new Date(now.getTime() + HOLD_DURATION_MINUTES * 60_000);

  try {
    return await prisma.appointment.create({
      data: {
        doctorId: doctor.id,
        patientId: params.patientId,
        date,
        startTime: params.startTime,
        endTime: minutesToTime(endMinutes),
        status: AppointmentStatus.HELD,
        holdExpiresAt,
      },
    });
  } catch (err) {
    if (isSlotTakenError(err)) throw conflict(SLOT_TAKEN_MESSAGE, 'SLOT_TAKEN');
    throw err;
  }
}

/**
 * An expired hold still occupies the unique index until the sweep flips it to
 * EXPIRED, so a hold attempt can legitimately collide with a dead row. Marking
 * it EXPIRED and retrying once keeps availability and bookability consistent
 * without waiting for the cron.
 */
export async function holdSlotWithReclaim(params: {
  doctorId: string;
  patientId: string;
  date: string;
  startTime: string;
  now?: Date;
}) {
  try {
    return await holdSlot(params);
  } catch (err) {
    const isTaken = err instanceof Error && 'code' in err && (err as { code?: string }).code === 'SLOT_TAKEN';
    if (!isTaken) throw err;

    const now = params.now ?? new Date();
    const reclaimed = await prisma.appointment.updateMany({
      where: {
        doctorId: params.doctorId,
        date: parseDateOnly(params.date),
        startTime: params.startTime,
        status: AppointmentStatus.HELD,
        holdExpiresAt: { lte: now },
      },
      data: { status: AppointmentStatus.EXPIRED, holdExpiresAt: null },
    });

    if (reclaimed.count === 0) throw err;
    return holdSlot(params);
  }
}

export async function expireStaleHolds(now: Date = new Date()): Promise<number> {
  const result = await prisma.appointment.updateMany({
    where: { status: AppointmentStatus.HELD, holdExpiresAt: { lte: now } },
    data: { status: AppointmentStatus.EXPIRED, holdExpiresAt: null },
  });
  return result.count;
}
