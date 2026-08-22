import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/errors';
import { query, validateQuery } from '../middleware/validate';
import { requireAuth } from '../middleware/auth';
import { isValidDateString } from '../lib/time';
import { getAvailability } from '../services/availability';

const router = Router();

const listSchema = z.object({
  specialization: z.string().optional(),
  q: z.string().optional(),
});

const availabilitySchema = z.object({
  date: z.string().refine(isValidDateString, 'Expected YYYY-MM-DD'),
});

router.get(
  '/',
  validateQuery(listSchema),
  asyncHandler(async (_req, res) => {
    const { specialization, q } = query<z.infer<typeof listSchema>>(res);

    const doctors = await prisma.doctorProfile.findMany({
      where: {
        ...(specialization && {
          specialization: { equals: specialization, mode: 'insensitive' },
        }),
        ...(q && {
          OR: [
            { specialization: { contains: q, mode: 'insensitive' as const } },
            { user: { name: { contains: q, mode: 'insensitive' as const } } },
          ],
        }),
      },
      select: {
        id: true,
        specialization: true,
        bio: true,
        slotDurationMinutes: true,
        user: { select: { name: true } },
        workingHours: { orderBy: { dayOfWeek: 'asc' } },
      },
      orderBy: { specialization: 'asc' },
    });

    res.json(doctors.map(({ user, ...d }) => ({ ...d, name: user.name })));
  })
);

router.get(
  '/specializations',
  asyncHandler(async (_req, res) => {
    const rows = await prisma.doctorProfile.findMany({
      distinct: ['specialization'],
      select: { specialization: true },
      orderBy: { specialization: 'asc' },
    });
    res.json(rows.map((r) => r.specialization));
  })
);

router.get(
  '/:id/availability',
  requireAuth,
  validateQuery(availabilitySchema),
  asyncHandler(async (req, res) => {
    const { date } = query<z.infer<typeof availabilitySchema>>(res);
    res.json(await getAvailability(req.params.id, date));
  })
);

export default router;
