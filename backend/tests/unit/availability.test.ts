import { afterAll, describe, expect, it } from 'vitest';
import { AppointmentStatus } from '@prisma/client';
import { prisma } from '../../src/lib/prisma';
import { getAvailability } from '../../src/services/availability';
import { parseDateOnly } from '../../src/lib/time';
import { cleanupDoctor, createDoctor, createPatient, futureDate } from '../helpers';

const created: string[] = [];

afterAll(async () => {
  for (const id of created) await cleanupDoctor(id);
  await prisma.$disconnect();
});

async function doctorOpenOn(date: string, slotMinutes = 30) {
  const dayOfWeek = parseDateOnly(date).getUTCDay();
  const doctor = await createDoctor({
    slotDurationMinutes: slotMinutes,
    workingHours: [{ dayOfWeek, startTime: '09:00', endTime: '12:00' }],
  });
  created.push(doctor.profile.id);
  return doctor;
}

describe('§4.1 slot availability', () => {
  it('generates slots across the working window', async () => {
    const date = futureDate(40);
    const doctor = await doctorOpenOn(date);

    const result = await getAvailability(doctor.profile.id, date);

    expect(result.onLeave).toBe(false);
    expect(result.slots.map((s) => s.startTime)).toEqual([
      '09:00',
      '09:30',
      '10:00',
      '10:30',
      '11:00',
      '11:30',
    ]);
  });

  it('honours a doctor-specific slot duration', async () => {
    const date = futureDate(41);
    const doctor = await doctorOpenOn(date, 60);

    const result = await getAvailability(doctor.profile.id, date);
    expect(result.slots.map((s) => s.startTime)).toEqual(['09:00', '10:00', '11:00']);
  });

  it('returns no slots on a day the doctor does not work', async () => {
    const date = futureDate(40);
    const doctor = await doctorOpenOn(date);

    const otherDay = futureDate(41);
    const result = await getAvailability(doctor.profile.id, otherDay);
    expect(result.slots).toEqual([]);
    expect(result.onLeave).toBe(false);
  });

  it('returns no slots and flags leave when the doctor is away', async () => {
    const date = futureDate(42);
    const doctor = await doctorOpenOn(date);

    await prisma.leave.create({
      data: { doctorId: doctor.profile.id, date: parseDateOnly(date), reason: 'Conference' },
    });

    const result = await getAvailability(doctor.profile.id, date);
    expect(result.onLeave).toBe(true);
    expect(result.leaveReason).toBe('Conference');
    expect(result.slots).toEqual([]);
  });

  it('excludes confirmed appointments but not cancelled ones', async () => {
    const date = futureDate(43);
    const doctor = await doctorOpenOn(date);
    const patient = await createPatient();

    await prisma.appointment.create({
      data: {
        doctorId: doctor.profile.id,
        patientId: patient.user.id,
        date: parseDateOnly(date),
        startTime: '09:00',
        endTime: '09:30',
        status: AppointmentStatus.CONFIRMED,
      },
    });
    await prisma.appointment.create({
      data: {
        doctorId: doctor.profile.id,
        patientId: patient.user.id,
        date: parseDateOnly(date),
        startTime: '10:00',
        endTime: '10:30',
        status: AppointmentStatus.CANCELLED,
      },
    });

    const starts = (await getAvailability(doctor.profile.id, date)).slots.map((s) => s.startTime);
    expect(starts).not.toContain('09:00');
    expect(starts).toContain('10:00');
  });

  it('treats a live hold as unavailable and an expired hold as available', async () => {
    const date = futureDate(44);
    const doctor = await doctorOpenOn(date);
    const patient = await createPatient();

    await prisma.appointment.create({
      data: {
        doctorId: doctor.profile.id,
        patientId: patient.user.id,
        date: parseDateOnly(date),
        startTime: '09:00',
        endTime: '09:30',
        status: AppointmentStatus.HELD,
        holdExpiresAt: new Date(Date.now() + 5 * 60_000),
      },
    });
    await prisma.appointment.create({
      data: {
        doctorId: doctor.profile.id,
        patientId: patient.user.id,
        date: parseDateOnly(date),
        startTime: '10:00',
        endTime: '10:30',
        status: AppointmentStatus.HELD,
        holdExpiresAt: new Date(Date.now() - 60_000),
      },
    });

    const starts = (await getAvailability(doctor.profile.id, date)).slots.map((s) => s.startTime);
    expect(starts).not.toContain('09:00');
    expect(starts).toContain('10:00');
  });

  it('hides slots that have already passed today', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const doctor = await doctorOpenOn(today);

    const asIfNoon = new Date(`${today}T10:15:00.000Z`);
    const result = await getAvailability(doctor.profile.id, today, asIfNoon);

    expect(result.slots.map((s) => s.startTime)).toEqual(['10:30', '11:00', '11:30']);
  });

  it('rejects an unknown doctor', async () => {
    await expect(getAvailability('does-not-exist', futureDate())).rejects.toThrow('Doctor not found');
  });
});
