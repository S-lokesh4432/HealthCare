import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { AppointmentStatus, NotificationStatus, SummaryStatus } from '@prisma/client';

vi.mock('../../src/services/llm', () => ({
  generatePreVisitSummary: vi.fn(),
  generatePostVisitSummary: vi.fn(),
}));

import app from '../../src/app';
import { prisma } from '../../src/lib/prisma';
import { generatePreVisitSummary, generatePostVisitSummary } from '../../src/services/llm';
import { cleanupDoctor, createDoctor, createPatient, futureDate } from '../helpers';
import { parseDateOnly } from '../../src/lib/time';

const created: string[] = [];

const okPreVisit = {
  data: { urgency: 'Medium' as const, chiefComplaint: 'Persistent cough', suggestedQuestions: ['a', 'b', 'c'] },
  status: 'OK' as const,
};

beforeAll(() => {
  vi.mocked(generatePreVisitSummary).mockResolvedValue(okPreVisit);
  vi.mocked(generatePostVisitSummary).mockResolvedValue({
    data: {
      summary: 'Rest and hydrate.',
      medicationSchedule: [{ medication: 'Amoxicillin', schedule: 'Twice daily' }],
      followUpSteps: ['Return in two weeks'],
    },
    status: 'OK',
  });
});

afterAll(async () => {
  for (const id of created) await cleanupDoctor(id);
  await prisma.$disconnect();
});

async function setup() {
  const date = futureDate(50);
  const doctor = await createDoctor({
    workingHours: [{ dayOfWeek: parseDateOnly(date).getUTCDay(), startTime: '09:00', endTime: '12:00' }],
  });
  created.push(doctor.profile.id);
  const patient = await createPatient();
  return { doctor, patient, date };
}

describe('§4.2 hold to confirm booking flow', () => {
  it('walks hold -> confirm and stores the pre-visit summary', async () => {
    const { doctor, patient, date } = await setup();

    const held = await request(app)
      .post('/api/appointments/hold')
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ doctorId: doctor.profile.id, date, startTime: '09:00' });

    expect(held.status).toBe(201);
    expect(held.body.status).toBe(AppointmentStatus.HELD);
    expect(new Date(held.body.holdExpiresAt).getTime()).toBeGreaterThan(Date.now());

    const confirmed = await request(app)
      .post(`/api/appointments/${held.body.id}/confirm`)
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ symptomText: 'Coughing for two weeks with mild fever' });

    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe(AppointmentStatus.CONFIRMED);
    expect(confirmed.body.preVisitStatus).toBe(SummaryStatus.OK);
    expect(confirmed.body.preVisitSummary.chiefComplaint).toBe('Persistent cough');

    const row = await prisma.appointment.findUnique({ where: { id: held.body.id } });
    expect(row?.holdExpiresAt).toBeNull();
  });

  it('records a FAILED summary state instead of inventing one when both providers fail', async () => {
    vi.mocked(generatePreVisitSummary).mockResolvedValueOnce({
      data: null,
      status: 'FAILED',
      error: 'gemini: down | xai: down',
    });

    const { doctor, patient, date } = await setup();

    const held = await request(app)
      .post('/api/appointments/hold')
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ doctorId: doctor.profile.id, date, startTime: '09:30' });

    const confirmed = await request(app)
      .post(`/api/appointments/${held.body.id}/confirm`)
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ symptomText: 'Headache and dizziness for three days' });

    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe(AppointmentStatus.CONFIRMED);
    expect(confirmed.body.preVisitStatus).toBe(SummaryStatus.FAILED);
    expect(confirmed.body.preVisitSummary).toBeNull();
  });

  it('marks the summary DEGRADED when the fallback provider answered', async () => {
    vi.mocked(generatePreVisitSummary).mockResolvedValueOnce({ ...okPreVisit, status: 'DEGRADED' });

    const { doctor, patient, date } = await setup();
    const held = await request(app)
      .post('/api/appointments/hold')
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ doctorId: doctor.profile.id, date, startTime: '10:00' });

    const confirmed = await request(app)
      .post(`/api/appointments/${held.body.id}/confirm`)
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ symptomText: 'Sore throat and fatigue' });

    expect(confirmed.body.preVisitStatus).toBe(SummaryStatus.DEGRADED);
  });

  it('refuses to confirm an expired hold', async () => {
    const { doctor, patient, date } = await setup();

    const held = await request(app)
      .post('/api/appointments/hold')
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ doctorId: doctor.profile.id, date, startTime: '10:30' });

    await prisma.appointment.update({
      where: { id: held.body.id },
      data: { holdExpiresAt: new Date(Date.now() - 1000) },
    });

    const confirmed = await request(app)
      .post(`/api/appointments/${held.body.id}/confirm`)
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ symptomText: 'Symptoms described here' });

    expect(confirmed.status).toBe(409);
    expect(confirmed.body.code).toBe('HOLD_EXPIRED');
  });

  it("refuses to confirm another patient's hold", async () => {
    const { doctor, patient, date } = await setup();
    const stranger = await createPatient();

    const held = await request(app)
      .post('/api/appointments/hold')
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ doctorId: doctor.profile.id, date, startTime: '11:00' });

    const confirmed = await request(app)
      .post(`/api/appointments/${held.body.id}/confirm`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .send({ symptomText: 'Trying to hijack a booking' });

    expect(confirmed.status).toBe(403);
  });

  it('rejects a slot outside working hours and one off the slot grid', async () => {
    const { doctor, patient, date } = await setup();

    const outside = await request(app)
      .post('/api/appointments/hold')
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ doctorId: doctor.profile.id, date, startTime: '15:00' });
    expect(outside.status).toBe(400);
    expect(outside.body.code).toBe('INVALID_SLOT');

    const misaligned = await request(app)
      .post('/api/appointments/hold')
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ doctorId: doctor.profile.id, date, startTime: '09:17' });
    expect(misaligned.status).toBe(400);
  });

  it('rejects a slot in the past', async () => {
    const doctor = await createDoctor();
    created.push(doctor.profile.id);
    const patient = await createPatient();

    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);

    const response = await request(app)
      .post('/api/appointments/hold')
      .set('Authorization', `Bearer ${patient.token}`)
      .send({
        doctorId: doctor.profile.id,
        date: yesterday.toISOString().slice(0, 10),
        startTime: '10:00',
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('SLOT_IN_PAST');
  });

  it('blocks a doctor from holding a patient slot', async () => {
    const { doctor, date } = await setup();

    const response = await request(app)
      .post('/api/appointments/hold')
      .set('Authorization', `Bearer ${doctor.token}`)
      .send({ doctorId: doctor.profile.id, date, startTime: '11:30' });

    expect(response.status).toBe(403);
  });
});

describe('§5 post-visit notes and prescriptions', () => {
  it('completes the visit, stores the summary, and schedules reminders', async () => {
    const { doctor, patient, date } = await setup();

    const held = await request(app)
      .post('/api/appointments/hold')
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ doctorId: doctor.profile.id, date, startTime: '09:00' });

    await request(app)
      .post(`/api/appointments/${held.body.id}/confirm`)
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ symptomText: 'Chest tightness after exercise' });

    const notes = await request(app)
      .post(`/api/appointments/${held.body.id}/notes`)
      .set('Authorization', `Bearer ${doctor.token}`)
      .send({
        postVisitNotes: 'Mild bronchitis. Prescribed amoxicillin.',
        prescriptions: [
          {
            medicationName: 'Amoxicillin',
            dosage: '500mg',
            frequencyPerDay: 3,
            durationDays: 5,
            instructions: 'Take with food',
          },
        ],
      });

    expect(notes.status).toBe(200);
    expect(notes.body.status).toBe(AppointmentStatus.COMPLETED);
    expect(notes.body.postVisitStatus).toBe(SummaryStatus.OK);

    const reminders = await prisma.medicationReminder.findMany({
      where: { prescription: { appointmentId: held.body.id } },
    });
    expect(reminders).toHaveLength(15);
    expect(reminders.every((r) => r.status === NotificationStatus.PENDING)).toBe(true);
  });

  it('lets the doctor edit the AI summary before it is sent', async () => {
    const { doctor, patient, date } = await setup();

    const held = await request(app)
      .post('/api/appointments/hold')
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ doctorId: doctor.profile.id, date, startTime: '09:30' });

    await request(app)
      .post(`/api/appointments/${held.body.id}/confirm`)
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ symptomText: 'Recurring migraines' });

    await request(app)
      .post(`/api/appointments/${held.body.id}/notes`)
      .set('Authorization', `Bearer ${doctor.token}`)
      .send({ postVisitNotes: 'Migraine management discussed.', prescriptions: [] });

    const edited = await request(app)
      .patch(`/api/appointments/${held.body.id}/summary`)
      .set('Authorization', `Bearer ${doctor.token}`)
      .send({
        summary: 'Doctor-reviewed wording.',
        medicationSchedule: [],
        followUpSteps: ['Keep a headache diary'],
      });

    expect(edited.status).toBe(200);
    expect(edited.body.postVisitSummary.summary).toBe('Doctor-reviewed wording.');
  });

  it("blocks a doctor from writing notes on another doctor's appointment", async () => {
    const { doctor, patient, date } = await setup();
    const other = await createDoctor();
    created.push(other.profile.id);

    const held = await request(app)
      .post('/api/appointments/hold')
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ doctorId: doctor.profile.id, date, startTime: '10:00' });

    const response = await request(app)
      .post(`/api/appointments/${held.body.id}/notes`)
      .set('Authorization', `Bearer ${other.token}`)
      .send({ postVisitNotes: 'Should not be allowed', prescriptions: [] });

    expect(response.status).toBe(403);
  });
});
