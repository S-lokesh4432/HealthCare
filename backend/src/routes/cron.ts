import crypto from 'node:crypto';
import { Router } from 'express';
import { env } from '../lib/env';
import { asyncHandler } from '../lib/errors';
import { runSweep } from '../services/sweep';

const router = Router();

function authorized(header: string | undefined): boolean {
  if (!env.cronSecret) return false;
  const expected = `Bearer ${env.cronSecret}`;
  const provided = header ?? '';
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.all(
  '/sweep',
  asyncHandler(async (req, res) => {
    if (!env.cronSecret) {
      return res.status(503).json({ error: 'CRON_SECRET is not configured on this deployment' });
    }
    if (!authorized(req.headers.authorization)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    res.json(await runSweep());
  })
);

export default router;
