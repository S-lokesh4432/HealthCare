import { prisma } from '../src/lib/prisma';
import { cleanupTestUsers } from './helpers';

export async function setup() {
  await cleanupTestUsers();
}

export async function teardown() {
  await cleanupTestUsers();
  await prisma.$disconnect();
}
