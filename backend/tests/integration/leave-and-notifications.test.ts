import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  AppointmentStatus,
  NotificationStatus,
  NotificationType,
} from '@prisma/client';

vi.mock('../../src/services/llm', () => ({
  generatePreVisitSummary: vi.fn().mockResolvedValue({ data: null, status: 'FAILED' }),
  generatePostVisitSummary: vi.fn().mockResolvedValue({ data: null, status: 'FAILED' }),
}));

import app from '../../src/app';
import { prisma } from '../../src/lib/prisma';
import { applyLeave } from '../../src/services/leave';
import { runSweep } from '../../src/services/sweep';
import { nextRetryDelayMinutes } from '../../src/services/email';
import { reminderTimestamps } from '../../src/services/reminders';
import { parseDateOnly } from '../../src/lib/time';
import { cleanupDoctor, createAdmin, createDoctor, createPatient, futureDate } from '../helpers';

const created: string[] = [];

afterAll(async () => {
  for (const id of created) await cleanupDoctor(id);
  await prisma.$disconnect();
});

describe('§4.4 doctor leave conflict handling', () => {
  it('cancels confirmed appointments and logs a notice per affected patient', async () => {
    const date = futureDate(60);
    const doctor = await createDoctor({
      workingHours: [
        { dayOfWeek: parseDateOnly(date).getUTCDay(), startTime: '09:00', endTime: '12:00' },
      ],
    });
    created.push(doctor.profile.id);

    const patients = await Promise.all([createPatient('A'), createPatient('B')]);
    const times = ['09:00', '09:30'];

    for (const [i, patient] of patients.entries()) {
      const held = await request(app)
        .post('/api/appointments/hold')
        .set('Authorization', `Bearer ${patient.token}`)
        .send({ doctorId: doctor.profile.id, date, startTime: times[i] });

      await request(app)
        .post(`/api/appointments/${held.body.id}/confirm`)
        .set('Authorization', `Bearer ${patient.token}`)
        .send({ symptomText: 'Symptom description for the visit' });
    }

    const result = await applyLeave(doctor.profile.id, parseDateOnly(date), 'Family emergency');

    expect(result.cancelledAppointments).toBe(2);
    // Email is unconfigured in tests, so every send is expected to fail loudly
    // rather than silently report success.
    expect(result.patientsNotified + result.notificationsFailed).toBe(2);

    const appointments = await prisma.appointment.findMany({
      where: { doctorId: doctor.profile.id, date: parseDateOnly(date) },
    });
    expect(appointments.every((a) => a.status === AppointmentStatus.CANCELLED)).toBe(true);

    const logs = await prisma.notificationLog.findMany({
      where: {
        userId: { in: patients.map((p) => p.user.id) },
        type: NotificationType.LEAVE_NOTICE,
      },
    });
    expect(logs).toHaveLength(2);
  });

  it('refuses to record the same leave day twice', async () => {
    const date = futureDate(61);
    const doctor = await createDoctor();
    created.push(doctor.profile.id);

    await applyLeave(doctor.profile.id, parseDateOnly(date), null);
    await expect(applyLeave(doctor.profile.id, parseDateOnly(date), null)).rejects.toThrow(
      'Leave already recorded'
    );
  });

  it('resolves concurrent leave requests for the same day to exactly one success, not a 500', async () => {
    const date = futureDate(65);
    const doctor = await createDoctor();
    created.push(doctor.profile.id);

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => applyLeave(doctor.profile.id, parseDateOnly(date), 'Race test'))
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected'
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const r of rejected) {
      expect(r.reason.message).toContain('Leave already recorded');
    }

    const leaves = await prisma.leave.findMany({
      where: { doctorId: doctor.profile.id, date: parseDateOnly(date) },
    });
    expect(leaves).toHaveLength(1);
  });

  it('reports affected counts to the admin rather than a bare success', async () => {
    const date = futureDate(62);
    const doctor = await createDoctor();
    created.push(doctor.profile.id);
    const admin = await createAdmin();

    const response = await request(app)
      .post(`/api/admin/doctors/${doctor.profile.id}/leave`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ date, reason: 'Training' });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      cancelledAppointments: expect.any(Number),
      patientsNotified: expect.any(Number),
      notificationsFailed: expect.any(Number),
    });
  });
});

describe('§4.5 notification failure handling', () => {
  beforeEach(async () => {
    await prisma.notificationLog.deleteMany({ where: { subject: { startsWith: '[retry-test]' } } });
  });

  it('uses an increasing backoff and stops at maxRetries', () => {
    expect(nextRetryDelayMinutes(0)).toBe(2);
    expect(nextRetryDelayMinutes(1)).toBe(10);
    expect(nextRetryDelayMinutes(2)).toBe(30);
    expect(nextRetryDelayMinutes(3)).toBe(120);
    expect(nextRetryDelayMinutes(4)).toBe(360);
    expect(nextRetryDelayMinutes(99)).toBe(360);
  });

  it('marks an exhausted log PERMANENTLY_FAILED instead of retrying forever', async () => {
    const patient = await createPatient();

    const log = await prisma.notificationLog.create({
      data: {
        userId: patient.user.id,
        type: NotificationType.BOOKING_CONFIRMATION,
        recipient: patient.user.email,
        subject: '[retry-test] exhausted',
        bodyHtml: '<p>x</p>',
        bodyText: 'x',
        status: NotificationStatus.FAILED,
        retryCount: 5,
        maxRetries: 5,
        nextRetryAt: new Date(Date.now() - 60_000),
      },
    });

    await runSweep();

    const after = await prisma.notificationLog.findUnique({ where: { id: log.id } });
    expect(after?.status).toBe(NotificationStatus.PERMANENTLY_FAILED);
    expect(after?.nextRetryAt).toBeNull();
  });

  it('leaves a not-yet-due failure alone', async () => {
    const patient = await createPatient();

    const log = await prisma.notificationLog.create({
      data: {
        userId: patient.user.id,
        type: NotificationType.BOOKING_CONFIRMATION,
        recipient: patient.user.email,
        subject: '[retry-test] not due',
        bodyHtml: '<p>x</p>',
        bodyText: 'x',
        status: NotificationStatus.FAILED,
        retryCount: 1,
        maxRetries: 5,
        nextRetryAt: new Date(Date.now() + 60 * 60_000),
      },
    });

    await runSweep();

    const after = await prisma.notificationLog.findUnique({ where: { id: log.id } });
    expect(after?.status).toBe(NotificationStatus.FAILED);
    expect(after?.retryCount).toBe(1);
  });
});

describe('§6 medication reminder scheduling and sweep', () => {
  it('generates frequency x duration reminders starting the day after the visit', () => {
    const visit = parseDateOnly('2026-09-01');
    const stamps = reminderTimestamps(3, 5, visit);

    expect(stamps).toHaveLength(15);
    expect(stamps[0].toISOString().slice(0, 10)).toBe('2026-09-02');
    expect(stamps.at(-1)!.toISOString().slice(0, 10)).toBe('2026-09-06');
  });

  it('processes everything already due, not only today', async () => {
    const doctor = await createDoctor();
    created.push(doctor.profile.id);
    const patient = await createPatient();

    const appointment = await prisma.appointment.create({
      data: {
        doctorId: doctor.profile.id,
        patientId: patient.user.id,
        date: parseDateOnly(futureDate(70)),
        startTime: '09:00',
        endTime: '09:30',
        status: AppointmentStatus.COMPLETED,
      },
    });

    const prescription = await prisma.prescription.create({
      data: {
        appointmentId: appointment.id,
        medicationName: 'TestMed',
        dosage: '10mg',
        frequencyPerDay: 1,
        durationDays: 1,
      },
    });

    await prisma.medicationReminder.create({
      data: {
        prescriptionId: prescription.id,
        patientId: patient.user.id,
        scheduledAt: new Date(Date.now() - 10 * 24 * 60 * 60_000),
      },
    });

    const report = await runSweep();
    expect(report.remindersDue).toBeGreaterThanOrEqual(1);

    const reminder = await prisma.medicationReminder.findFirst({
      where: { prescriptionId: prescription.id },
    });
    expect(reminder?.status).not.toBe(NotificationStatus.PENDING);
  });

  it('flips expired holds to EXPIRED', async () => {
    const doctor = await createDoctor();
    created.push(doctor.profile.id);
    const patient = await createPatient();

    const stale = await prisma.appointment.create({
      data: {
        doctorId: doctor.profile.id,
        patientId: patient.user.id,
        date: parseDateOnly(futureDate(71)),
        startTime: '09:00',
        endTime: '09:30',
        status: AppointmentStatus.HELD,
        holdExpiresAt: new Date(Date.now() - 60_000),
      },
    });

    await runSweep();

    const after = await prisma.appointment.findUnique({ where: { id: stale.id } });
    expect(after?.status).toBe(AppointmentStatus.EXPIRED);
  });
});

describe('cron endpoint authorisation', () => {
  it('rejects a missing or wrong secret and accepts the right one', async () => {
    expect((await request(app).post('/api/cron/sweep')).status).toBe(401);
    expect(
      (await request(app).post('/api/cron/sweep').set('Authorization', 'Bearer wrong')).status
    ).toBe(401);

    const ok = await request(app)
      .post('/api/cron/sweep')
      .set('Authorization', `Bearer ${process.env.CRON_SECRET}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toHaveProperty('holdsExpired');
  });
});
