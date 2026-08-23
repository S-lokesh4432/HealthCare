import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { asyncHandler, badRequest } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { signToken, verifyToken } from '../lib/jwt';
import { buildAuthUrl, disconnect, exchangeCodeForTokens, isConfigured } from '../services/calendar/google';

const router = Router();

router.get(
  '/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const connection = await prisma.calendarConnection.findUnique({
      where: { userId: req.auth!.userId },
      select: { googleCalendarId: true, expiresAt: true },
    });
    res.json({ configured: isConfigured(), connected: Boolean(connection), connection });
  })
);

router.get(
  '/connect',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!isConfigured()) {
      throw badRequest(
        'Google Calendar is not configured on this deployment (GOOGLE_CLIENT_ID / SECRET / REDIRECT_URI / ENCRYPTION_KEY)',
        'CALENDAR_NOT_CONFIGURED'
      );
    }
    // The state token is what proves identity on the callback, since Google
    // redirects the browser without our Authorization header.
    res.json({ url: buildAuthUrl(signToken(req.auth!)) });
  })
);

router.get(
  '/callback',
  asyncHandler(async (req, res) => {
    const { code, state, error } = req.query as Record<string, string | undefined>;

    if (error) return res.status(400).send(page('Calendar connection cancelled', error));
    if (!code || !state) return res.status(400).send(page('Missing code or state', 'Try connecting again.'));

    const payload = verifyToken(state);
    if (!payload) return res.status(401).send(page('Link expired', 'Please start the connection again.'));

    try {
      await exchangeCodeForTokens(code, payload.userId);
      res.send(page('Calendar connected', 'You can close this tab and return to the portal.'));
    } catch (err) {
      res
        .status(502)
        .send(page('Could not connect calendar', err instanceof Error ? err.message : String(err)));
    }
  })
);

router.delete(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    await disconnect(req.auth!.userId);
    res.json({ disconnected: true });
  })
);

function page(title: string, message: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title></head>
<body style="font-family:system-ui,sans-serif;padding:40px;max-width:520px;margin:0 auto">
<h2>${escape(title)}</h2><p>${escape(message)}</p>
<p><a href="${escape(env.appBaseUrl)}">Return to the portal</a></p>
</body></html>`;
}

export default router;
