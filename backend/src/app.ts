import { NextFunction, Request, Response } from 'express';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env, featureStatus } from './lib/env';
import { prisma } from './lib/prisma';
import { ApiError } from './lib/errors';
import { authLimiter, globalLimiter } from './middleware/rateLimit';
import authRoutes from './routes/auth';
import adminRoutes from './routes/admin';
import doctorRoutes from './routes/doctors';
import appointmentRoutes from './routes/appointments';
import calendarRoutes from './routes/calendar';
import cronRoutes from './routes/cron';

const app = express();

// Vercel (and most PaaS) terminate TLS at a proxy in front of the app;
// without this, express-rate-limit keys every request off the proxy's IP
// instead of the client's, collapsing the whole limit onto one bucket.
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({ origin: env.corsOrigin === '*' ? true : env.corsOrigin.split(',') }));
app.use(express.json({ limit: '1mb' }));
app.use('/api', globalLimiter);
app.use('/api/auth', authLimiter);

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
