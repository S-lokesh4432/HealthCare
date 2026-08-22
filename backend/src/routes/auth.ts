import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { signToken } from '../lib/jwt';
import { asyncHandler, conflict, notFound, unauthorized } from '../lib/errors';
import { validateBody } from '../middleware/validate';
import { requireAuth } from '../middleware/auth';

const router = Router();

// Compared against when the email is unknown, so login latency does not reveal
// whether an account exists.
const DUMMY_HASH = '$2a$10$EKUaWlWSLW4UAcLOrfWpSeUZ.rcPYxDFzVoTTcUmez5ztXBjSV/DK';

const registerSchema = z.object({
  email: z.string().email().transform((e) => e.toLowerCase()),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1),
  phone: z.string().min(5).optional(),
});

const loginSchema = z.object({
  email: z.string().email().transform((e) => e.toLowerCase()),
  password: z.string().min(1),
});

router.post(
  '/register',
  validateBody(registerSchema),
  asyncHandler(async (req, res) => {
    const { email, password, name, phone } = req.body as z.infer<typeof registerSchema>;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw conflict('An account with that email already exists', 'EMAIL_TAKEN');

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(password, 10),
        name,
        phone: phone ?? null,
        role: Role.PATIENT,
      },
    });

    res.status(201).json({
      token: signToken({ userId: user.id, role: user.role }),
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  })
);

router.post(
  '/login',
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body as z.infer<typeof loginSchema>;

    const user = await prisma.user.findUnique({ where: { email } });
    const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);

    if (!user || !ok) throw unauthorized('Invalid email or password');

    res.json({
      token: signToken({ userId: user.id, role: user.role }),
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  })
);

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.auth!.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        phone: true,
        doctorProfile: { select: { id: true, specialization: true } },
        calendarConnection: { select: { googleCalendarId: true, expiresAt: true } },
      },
    });
    if (!user) throw notFound('User no longer exists');

    res.json({
      ...user,
      calendarConnected: Boolean(user.calendarConnection),
      calendarConnection: undefined,
    });
  })
);

export default router;
