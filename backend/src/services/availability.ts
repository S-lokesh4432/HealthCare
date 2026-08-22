import { AppointmentStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { notFound } from '../lib/errors';
import { clinicTimeToInstant, dayOfWeek, parseDateOnly, slotRange } from '../lib/time';

export interface Slot {
  startTime: string;
  endTime: string;
}

export interface AvailabilityResult {
  doctorId: string;
  date: string;
  slotDurationMinutes: number;
  onLeave: boolean;
  leaveReason: string | null;
  slots: Slot[];
}

export async function getAvailability(
  doctorId: string,
  dateString: string,
  now: Date = new Date()
): Promise<AvailabilityResult> {
  const date = parseDateOnly(dateString);

  const doctor = await prisma.doctorProfile.findUnique({
    where: { id: doctorId },
    select: { id: true, slotDurationMinutes: true },
  });
  if (!doctor) throw notFound('Doctor not found');

  const [workingHour, leave, taken] = await Promise.all([
    prisma.workingHour.findUnique({
      where: { doctorId_dayOfWeek: { doctorId, dayOfWeek: dayOfWeek(date) } },
    }),
    prisma.leave.findUnique({ where: { doctorId_date: { doctorId, date } } }),
    prisma.appointment.findMany({
      where: {
        doctorId,
        date,
        OR: [
          { status: AppointmentStatus.CONFIRMED },
          { status: AppointmentStatus.COMPLETED },
          { status: AppointmentStatus.HELD, holdExpiresAt: { gt: now } },
        ],
      },
      select: { startTime: true },
    }),
  ]);

  const base = {
    doctorId,
    date: dateString,
    slotDurationMinutes: doctor.slotDurationMinutes,
  };

  if (leave) {
    return { ...base, onLeave: true, leaveReason: leave.reason, slots: [] };
  }
  if (!workingHour) {
    return { ...base, onLeave: false, leaveReason: null, slots: [] };
  }

  const takenStarts = new Set(taken.map((a) => a.startTime));

  const slots = slotRange(
    workingHour.startTime,
    workingHour.endTime,
    doctor.slotDurationMinutes
  ).filter(
    (slot) =>
      !takenStarts.has(slot.startTime) &&
      clinicTimeToInstant(dateString, slot.startTime).getTime() > now.getTime()
  );

  return { ...base, onLeave: false, leaveReason: null, slots };
}
