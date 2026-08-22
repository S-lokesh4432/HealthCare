import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, conflict, notFound } from '../lib/errors';
import { validateBody } from '../middleware/validate';
import { requireAuth, requireRole } from '../middleware/auth';
import { isValidDateString, isValidTimeString, parseDateOnly, timeToMinutes } from '../lib/time';
import { applyLeave } from '../services/leave';

const router = Router();
router.use(requireAuth, requireRole(Role.ADMIN));

const workingHourSchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    startTime: z.string().refine(isValidTimeString, 'Expected HH:MM'),
    endTime: z.string().refine(isValidTimeString, 'Expected HH:MM'),
  })
  .refine((wh) => timeToMinutes(wh.endTime) > timeToMinutes(wh.startTime), {
    message: 'endTime must be after startTime',
  });

const createDoctorSchema = z.object({
  email: z.string().email().transform((e) => e.toLowerCase()),
  password: z.string().min(8),
  name: z.string().min(1),
  phone: z.string().min(5).optional(),
  specialization: z.string().min(1),
  bio: z.string().optional(),
  slotDurationMinutes: z.number().int().min(5).max(240).default(30),
  workingHours: z.array(workingHourSchema).default([]),
});

const updateDoctorSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().min(5).nullable().optional(),
  specialization: z.string().min(1).optional(),
  bio: z.string().nullable().optional(),
  slotDurationMinutes: z.number().int().min(5).max(240).optional(),
  workingHours: z.array(workingHourSchema).optional(),
});

const leaveSchema = z.object({
  date: z.string().refine(isValidDateString, 'Expected YYYY-MM-DD'),
  reason: z.string().optional(),
});

function assertUniqueDays(hours: { dayOfWeek: number }[]) {
  const days = new Set(hours.map((h) => h.dayOfWeek));
  if (days.size !== hours.length) throw badRequest('Duplicate dayOfWeek in workingHours');
}

router.post(
  '/doctors',
  validateBody(createDoctorSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createDoctorSchema>;
    assertUniqueDays(body.workingHours);

    if (await prisma.user.findUnique({ where: { email: body.email } })) {
      throw conflict('An account with that email already exists', 'EMAIL_TAKEN');
    }

    const doctor = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: body.email,
          passwordHash: await bcrypt.hash(body.password, 10),
          name: body.name,
          phone: body.phone ?? null,
          role: Role.DOCTOR,
        },
      });

      return tx.doctorProfile.create({
        data: {
          userId: user.id,
          specialization: body.specialization,
          bio: body.bio ?? null,
          slotDurationMinutes: body.slotDurationMinutes,
          workingHours: { create: body.workingHours },
        },
        include: { user: { select: { id: true, email: true, name: true } }, workingHours: true },
      });
    });

    res.status(201).json(doctor);
  })
);

router.get(
  '/doctors',
  asyncHandler(async (_req, res) => {
    const doctors = await prisma.doctorProfile.findMany({
      include: {
        user: { select: { id: true, email: true, name: true, phone: true } },
        workingHours: { orderBy: { dayOfWeek: 'asc' } },
        leaves: { orderBy: { date: 'asc' } },
      },
    });
    res.json(doctors);
  })
);

router.patch(
  '/doctors/:id',
  validateBody(updateDoctorSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof updateDoctorSchema>;
    if (body.workingHours) assertUniqueDays(body.workingHours);

    const existing = await prisma.doctorProfile.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Doctor not found');

    const updated = await prisma.$transaction(async (tx) => {
      if (body.name !== undefined || body.phone !== undefined) {
        await tx.user.update({
          where: { id: existing.userId },
          data: {
            ...(body.name !== undefined && { name: body.name }),
            ...(body.phone !== undefined && { phone: body.phone }),
          },
        });
      }

      if (body.workingHours) {
        await tx.workingHour.deleteMany({ where: { doctorId: existing.id } });
        await tx.workingHour.createMany({
          data: body.workingHours.map((wh) => ({ ...wh, doctorId: existing.id })),
        });
      }

      return tx.doctorProfile.update({
        where: { id: existing.id },
        data: {
          ...(body.specialization !== undefined && { specialization: body.specialization }),
          ...(body.bio !== undefined && { bio: body.bio }),
          ...(body.slotDurationMinutes !== undefined && {
            slotDurationMinutes: body.slotDurationMinutes,
          }),
        },
        include: {
          user: { select: { id: true, email: true, name: true } },
          workingHours: { orderBy: { dayOfWeek: 'asc' } },
        },
      });
    });

    res.json(updated);
  })
);

router.post(
  '/doctors/:id/leave',
  validateBody(leaveSchema),
  asyncHandler(async (req, res) => {
    const { date, reason } = req.body as z.infer<typeof leaveSchema>;

    const doctor = await prisma.doctorProfile.findUnique({ where: { id: req.params.id } });
    if (!doctor) throw notFound('Doctor not found');

    const result = await applyLeave(doctor.id, parseDateOnly(date), reason ?? null);
    res.status(201).json(result);
  })
);

router.delete(
  '/doctors/:id/leave/:date',
  asyncHandler(async (req, res) => {
    if (!isValidDateString(req.params.date)) throw badRequest('Expected YYYY-MM-DD');

    const doctor = await prisma.doctorProfile.findUnique({ where: { id: req.params.id } });
    if (!doctor) throw notFound('Doctor not found');

    const deleted = await prisma.leave.deleteMany({
      where: { doctorId: doctor.id, date: parseDateOnly(req.params.date) },
    });
    if (deleted.count === 0) throw notFound('No leave recorded for that date');

    res.json({ removed: true });
  })
);

router.get(
  '/appointments',
  asyncHandler(async (_req, res) => {
    const appointments = await prisma.appointment.findMany({
      orderBy: [{ date: 'desc' }, { startTime: 'asc' }],
      take: 500,
      include: {
        patient: { select: { id: true, name: true, email: true } },
        doctor: {
          select: { id: true, specialization: true, user: { select: { name: true } } },
        },
      },
    });
    res.json(appointments);
  })
);

router.get(
  '/notifications',
  asyncHandler(async (req, res) => {
    const onlyFailed = req.query.failed === 'true';
    const logs = await prisma.notificationLog.findMany({
      where: onlyFailed ? { status: { in: ['FAILED', 'PERMANENTLY_FAILED'] } } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { user: { select: { name: true, email: true } } },
    });
    res.json(logs);
  })
);

export default router;
