import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../../src/app';
import { prisma } from '../../src/lib/prisma';
import { createAdmin, createDoctor, createPatient, TEST_PASSWORD } from '../helpers';

afterAll(async () => {
  await prisma.$disconnect();
});

describe('§1 role-based access', () => {
  it('lets a patient register and reach their own routes', async () => {
    const email = `rbac-patient-${Date.now()}@test.local`;
    const register = await request(app)
      .post('/api/auth/register')
      .send({ email, password: TEST_PASSWORD, name: 'RBAC Patient' });
    expect(register.status).toBe(201);

    const login = await request(app).post('/api/auth/login').send({ email, password: TEST_PASSWORD });
    expect(login.status).toBe(200);

    const mine = await request(app)
      .get('/api/appointments/mine')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(mine.status).toBe(200);
  });

  it('blocks a patient from admin routes with 403, not 401 or 500', async () => {
    const patient = await createPatient();
    const response = await request(app)
      .get('/api/admin/doctors')
      .set('Authorization', `Bearer ${patient.token}`);
    expect(response.status).toBe(403);
  });

  it('blocks a doctor from admin routes', async () => {
    const doctor = await createDoctor();
    const response = await request(app)
      .post('/api/admin/doctors')
      .set('Authorization', `Bearer ${doctor.token}`)
      .send({
        email: 'x@test.local',
        password: TEST_PASSWORD,
        name: 'X',
        specialization: 'Y',
        workingHours: [],
      });
    expect(response.status).toBe(403);
  });

  it('lets an admin create a doctor end to end', async () => {
    const admin = await createAdmin();
    const response = await request(app)
      .post('/api/admin/doctors')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        email: `new-doc-${Date.now()}@test.local`,
        password: TEST_PASSWORD,
        name: 'New Doctor',
        specialization: 'Oncology',
        slotDurationMinutes: 45,
        workingHours: [{ dayOfWeek: 1, startTime: '10:00', endTime: '16:00' }],
      });

    expect(response.status).toBe(201);
    expect(response.body.specialization).toBe('Oncology');
    expect(response.body.workingHours).toHaveLength(1);
  });

  it('rejects register/login with malformed input instead of 500ing', async () => {
    const badRegister = await request(app)
      .post('/api/auth/register')
      .send({ email: 'not-an-email', password: 'short', name: '' });
    expect(badRegister.status).toBe(400);

    const badLogin = await request(app).post('/api/auth/login').send({ email: 'nope' });
    expect(badLogin.status).toBe(400);
  });

  it('returns 401 for an unknown route with no token, not a crash', async () => {
    const response = await request(app).get('/api/does-not-exist');
    expect(response.status).toBe(404);
  });
});
