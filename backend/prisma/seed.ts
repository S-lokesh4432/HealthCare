/**
 * DEMO/DEV SEED DATA ONLY.
 * These accounts, IDs, and emails exist solely for local development and manual QA.
 * Application code must never hardcode or depend on any ID created here.
 */
import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const DEMO_PASSWORD = 'Demo@1234';

async function main() {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@demo.local' },
    update: {},
    create: {
      email: 'admin@demo.local',
      passwordHash,
      role: Role.ADMIN,
      name: '[DEMO] Admin User',
    },
  });

  const doctorSeeds = [
    {
      email: 'dr.patel@demo.local',
      name: '[DEMO] Dr. Anjali Patel',
      specialization: 'Cardiology',
      slotDurationMinutes: 30,
      bio: 'Demo cardiologist for local development.',
      workingHours: [
        { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' },
        { dayOfWeek: 2, startTime: '09:00', endTime: '17:00' },
        { dayOfWeek: 3, startTime: '09:00', endTime: '13:00' },
        { dayOfWeek: 4, startTime: '09:00', endTime: '17:00' },
        { dayOfWeek: 5, startTime: '09:00', endTime: '15:00' },
      ],
    },
    {
      email: 'dr.khan@demo.local',
      name: '[DEMO] Dr. Imran Khan',
      specialization: 'Dermatology',
      slotDurationMinutes: 20,
      bio: 'Demo dermatologist for local development.',
      workingHours: [
        { dayOfWeek: 0, startTime: '10:00', endTime: '14:00' },
        { dayOfWeek: 2, startTime: '11:00', endTime: '19:00' },
        { dayOfWeek: 4, startTime: '11:00', endTime: '19:00' },
        { dayOfWeek: 6, startTime: '10:00', endTime: '14:00' },
      ],
    },
    {
      email: 'dr.reyes@demo.local',
      name: '[DEMO] Dr. Camila Reyes',
      specialization: 'Pediatrics',
      slotDurationMinutes: 15,
      bio: 'Demo pediatrician for local development.',
      workingHours: [
        { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
        { dayOfWeek: 2, startTime: '08:00', endTime: '12:00' },
        { dayOfWeek: 3, startTime: '08:00', endTime: '12:00' },
        { dayOfWeek: 4, startTime: '08:00', endTime: '12:00' },
        { dayOfWeek: 5, startTime: '08:00', endTime: '12:00' },
      ],
    },
  ];

  for (const seed of doctorSeeds) {
    const user = await prisma.user.upsert({
      where: { email: seed.email },
      update: {},
      create: {
        email: seed.email,
        passwordHash,
        role: Role.DOCTOR,
        name: seed.name,
      },
    });

    const profile = await prisma.doctorProfile.upsert({
      where: { userId: user.id },
      update: {
        specialization: seed.specialization,
        bio: seed.bio,
        slotDurationMinutes: seed.slotDurationMinutes,
      },
      create: {
        userId: user.id,
        specialization: seed.specialization,
        bio: seed.bio,
        slotDurationMinutes: seed.slotDurationMinutes,
      },
    });

    for (const wh of seed.workingHours) {
      await prisma.workingHour.upsert({
        where: { doctorId_dayOfWeek: { doctorId: profile.id, dayOfWeek: wh.dayOfWeek } },
        update: { startTime: wh.startTime, endTime: wh.endTime },
        create: { doctorId: profile.id, ...wh },
      });
    }
  }

  console.log('[seed] demo data ready:');
  console.log(`  admin: ${admin.email} / ${DEMO_PASSWORD}`);
  for (const d of doctorSeeds) {
    console.log(`  doctor (${d.specialization}): ${d.email} / ${DEMO_PASSWORD}`);
  }
}

main()
  .catch((err) => {
    console.error('[seed] failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
