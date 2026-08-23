import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { Role } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import { signToken } from '../src/lib/jwt';

export const TEST_PASSWORD = 'TestPass123';

let counter = 0;
const unique = () => `${Date.now()}-${process.pid}-${counter++}`;

export async function createPatient(name = 'Test Patient') {
  const user = await prisma.user.create({
    data: {
      email: `patient-${unique()}@test.local`,
      passwordHash: await bcrypt.hash(TEST_PASSWORD, 4),
      name,
      role: Role.PATIENT,
    },
  });
  return { user, token: signToken({ userId: user.id, role: user.role }) };
}

export async function createAdmin() {
  const user = await prisma.user.create({
    data: {
      email: `admin-${unique()}@test.local`,
      passwordHash: await bcrypt.hash(TEST_PASSWORD, 4),
      name: 'Test Admin',
      role: Role.ADMIN,
    },
  });
  return { user, token: signToken({ userId: user.id, role: user.role }) };
}

export async function createDoctor(options: {
  slotDurationMinutes?: number;
  workingHours?: { dayOfWeek: number; startTime: string; endTime: string }[];
} = {}) {
  const user = await prisma.user.create({
    data: {
      email: `doctor-${unique()}@test.local`,
      passwordHash: await bcrypt.hash(TEST_PASSWORD, 4),
      name: 'Test Doctor',
      role: Role.DOCTOR,
    },
  });

  const allDays = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
    dayOfWeek,
    startTime: '09:00',
    endTime: '17:00',
  }));

  const profile = await prisma.doctorProfile.create({
    data: {
      userId: user.id,
      specialization: 'Test Specialization',
      slotDurationMinutes: options.slotDurationMinutes ?? 30,
      workingHours: { create: options.workingHours ?? allDays },
    },
  });

  return { user, profile, token: signToken({ userId: user.id, role: user.role }) };
}

/** A date far enough ahead that the past-slot guard never trips. */
export function futureDate(daysAhead = 30): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

export async function cleanupDoctor(doctorProfileId: string) {
  const appointments = await prisma.appointment.findMany({
    where: { doctorId: doctorProfileId },
    select: { id: true },
  });
  const ids = appointments.map((a) => a.id);

  await prisma.medicationReminder.deleteMany({
    where: { prescription: { appointmentId: { in: ids } } },
  });
  await prisma.prescription.deleteMany({ where: { appointmentId: { in: ids } } });
  await prisma.calendarEvent.deleteMany({ where: { appointmentId: { in: ids } } });
  await prisma.appointment.deleteMany({ where: { doctorId: doctorProfileId } });
  await prisma.leave.deleteMany({ where: { doctorId: doctorProfileId } });
  await prisma.workingHour.deleteMany({ where: { doctorId: doctorProfileId } });

  // The profile and its user must go too, or every run leaves another
  // "Test Specialization" doctor behind that shows up in the real UI.
  const profile = await prisma.doctorProfile.findUnique({
    where: { id: doctorProfileId },
    select: { userId: true },
  });
  if (!profile) return;

  await prisma.doctorProfile.delete({ where: { id: doctorProfileId } });
  await prisma.notificationLog.deleteMany({ where: { userId: profile.userId } });
  await prisma.calendarConnection.deleteMany({ where: { userId: profile.userId } });
  await prisma.user.delete({ where: { id: profile.userId } });
}

/**
 * Removes every @test.local account and everything hanging off it, doctors
 * included, so a test run never leaves rows behind that show up in the real UI.
 */
export async function cleanupTestUsers() {
  const users = await prisma.user.findMany({
    where: { email: { endsWith: '@test.local' } },
    select: { id: true, doctorProfile: { select: { id: true } } },
  });
  if (users.length === 0) return;

  const userIds = users.map((u) => u.id);
  const profileIds = users.flatMap((u) => (u.doctorProfile ? [u.doctorProfile.id] : []));

  const appointments = await prisma.appointment.findMany({
    where: { OR: [{ patientId: { in: userIds } }, { doctorId: { in: profileIds } }] },
    select: { id: true },
  });
  const apptIds = appointments.map((a) => a.id);

  await prisma.medicationReminder.deleteMany({
    where: { prescription: { appointmentId: { in: apptIds } } },
  });
  await prisma.prescription.deleteMany({ where: { appointmentId: { in: apptIds } } });
  await prisma.calendarEvent.deleteMany({ where: { appointmentId: { in: apptIds } } });
  await prisma.appointment.deleteMany({ where: { id: { in: apptIds } } });
  await prisma.leave.deleteMany({ where: { doctorId: { in: profileIds } } });
  await prisma.workingHour.deleteMany({ where: { doctorId: { in: profileIds } } });
  await prisma.doctorProfile.deleteMany({ where: { id: { in: profileIds } } });
  await prisma.notificationLog.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.calendarConnection.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}
