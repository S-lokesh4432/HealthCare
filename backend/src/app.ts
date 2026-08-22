import { NextFunction, Request, Response } from 'express';
import express from 'express';
import cors from 'cors';
import { env, featureStatus } from './lib/env';
import { prisma } from './lib/prisma';
import { ApiError } from './lib/errors';
import authRoutes from './routes/auth';
import adminRoutes from './routes/admin';
import doctorRoutes from './routes/doctors';
import appointmentRoutes from './routes/appointments';
import calendarRoutes from './routes/calendar';
import cronRoutes from './routes/cron';

const app = express();

app.use(cors({ origin: env.corsOrigin === '*' ? true : env.corsOrigin.split(',') }));
app.use(express.json({ limit: '1mb' }));

app.get('/health', async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', db: 'connected', features: featureStatus });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'unreachable', features: featureStatus });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/doctors', doctorRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/cron', cronRoutes);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
  app.listen(env.port, () => {
    console.log(`[backend] listening on :${env.port}`);
    console.log('[backend] features:', featureStatus);
  });
}

export default app;
