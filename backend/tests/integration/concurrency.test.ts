import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { AppointmentStatus } from '@prisma/client';
import app from '../../src/app';
import { prisma } from '../../src/lib/prisma';
import { cleanupDoctor, createDoctor, createPatient, futureDate } from '../helpers';

const CONCURRENT_REQUESTS = 10;

describe('§4.3 double-booking under concurrent requests', () => {
  const createdDoctors: string[] = [];

  afterAll(async () => {
    for (const id of createdDoctors) await cleanupDoctor(id);
    await prisma.$disconnect();
  });

  it('accepts exactly one of 10 simultaneous holds on the same slot', async () => {
    const doctor = await createDoctor();
    createdDoctors.push(doctor.profile.id);

    const patients = await Promise.all(
      Array.from({ length: CONCURRENT_REQUESTS }, (_, i) => createPatient(`Racer ${i}`))
    );

    const date = futureDate();
    const payload = { doctorId: doctor.profile.id, date, startTime: '10:00' };

    const responses = await Promise.all(
      patients.map((p) =>
        request(app)
          .post('/api/appointments/hold')
          .set('Authorization', `Bearer ${p.token}`)
          .send(payload)
      )
    );

    const created = responses.filter((r) => r.status === 201);
    const conflicts = responses.filter((r) => r.status === 409);
    const other = responses.filter((r) => r.status !== 201 && r.status !== 409);

    expect(other.map((r) => `${r.status}: ${JSON.stringify(r.body)}`)).toEqual([]);
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(CONCURRENT_REQUESTS - 1);

    for (const conflict of conflicts) {
      expect(conflict.body.code).toBe('SLOT_TAKEN');
    }

    const rows = await prisma.appointment.findMany({
      where: {
        doctorId: doctor.profile.id,
        startTime: '10:00',
        status: { in: [AppointmentStatus.HELD, AppointmentStatus.CONFIRMED] },
      },
    });
    expect(rows).toHaveLength(1);
  });

  it('frees the slot once the winning hold is cancelled', async () => {
    const doctor = await createDoctor();
    createdDoctors.push(doctor.profile.id);

    const first = await createPatient();
    const second = await createPatient();
    const date = futureDate();
    const payload = { doctorId: doctor.profile.id, date, startTime: '11:00' };

    const held = await request(app)
      .post('/api/appointments/hold')
      .set('Authorization', `Bearer ${first.token}`)
      .send(payload);
    expect(held.status).toBe(201);

    const blocked = await request(app)
      .post('/api/appointments/hold')
      .set('Authorization', `Bearer ${second.token}`)
      .send(payload);
    expect(blocked.status).toBe(409);

    await request(app)
      .post(`/api/appointments/${held.body.id}/cancel`)
      .set('Authorization', `Bearer ${first.token}`)
      .send();

    const retry = await request(app)
      .post('/api/appointments/hold')
      .set('Authorization', `Bearer ${second.token}`)
      .send(payload);
    expect(retry.status).toBe(201);
  });

  it('reclaims an expired hold instead of rejecting the next patient', async () => {
    const doctor = await createDoctor();
    createdDoctors.push(doctor.profile.id);

    const first = await createPatient();
    const second = await createPatient();
    const date = futureDate();
    const payload = { doctorId: doctor.profile.id, date, startTime: '12:00' };

    const held = await request(app)
      .post('/api/appointments/hold')
      .set('Authorization', `Bearer ${first.token}`)
      .send(payload);
    expect(held.status).toBe(201);

    await prisma.appointment.update({
      where: { id: held.body.id },
      data: { holdExpiresAt: new Date(Date.now() - 60_000) },
    });

    const retry = await request(app)
      .post('/api/appointments/hold')
      .set('Authorization', `Bearer ${second.token}`)
      .send(payload);

    expect(retry.status).toBe(201);
    expect(retry.body.id).not.toBe(held.body.id);

    const expired = await prisma.appointment.findUnique({ where: { id: held.body.id } });
    expect(expired?.status).toBe(AppointmentStatus.EXPIRED);
  });
});
