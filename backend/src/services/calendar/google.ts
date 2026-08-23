import { prisma } from '../../lib/prisma';
import { env } from '../../lib/env';
import { decrypt, encrypt } from '../../lib/crypto';
import { clinicTimeToInstant, CLINIC_TIMEZONE } from '../../lib/time';

const OAUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

export interface CalendarResult<T = void> {
  ok: boolean;
  data?: T;
  skipped?: 'NOT_CONNECTED' | 'NOT_CONFIGURED';
  error?: string;
}

export function isConfigured(): boolean {
  return Boolean(
    env.googleClientId && env.googleClientSecret && env.googleRedirectUri && env.encryptionKey
  );
}

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.googleClientId!,
    redirect_uri: env.googleRedirectUri!,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${OAUTH_BASE}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      `Google token endpoint ${response.status}: ${JSON.stringify(payload).slice(0, 300)}`
    );
  }
  return payload as unknown as TokenResponse;
}

export async function exchangeCodeForTokens(code: string, userId: string): Promise<void> {
  const tokens = await postToken({
    code,
    client_id: env.googleClientId!,
    client_secret: env.googleClientSecret!,
    redirect_uri: env.googleRedirectUri!,
    grant_type: 'authorization_code',
  });

  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Revoke prior access and retry with prompt=consent.'
    );
  }

  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  const data = {
    accessTokenEnc: encrypt(tokens.access_token),
    refreshTokenEnc: encrypt(tokens.refresh_token),
    expiresAt,
  };

  await prisma.calendarConnection.upsert({
    where: { userId },
    update: data,
    create: { userId, ...data },
  });
}

async function accessTokenFor(userId: string): Promise<string | null> {
  const connection = await prisma.calendarConnection.findUnique({ where: { userId } });
  if (!connection) return null;

  if (connection.expiresAt.getTime() > Date.now() + 60_000) {
    return decrypt(connection.accessTokenEnc);
  }

  const refreshed = await postToken({
    refresh_token: decrypt(connection.refreshTokenEnc),
    client_id: env.googleClientId!,
    client_secret: env.googleClientSecret!,
    grant_type: 'refresh_token',
  });

  await prisma.calendarConnection.update({
    where: { userId },
    data: {
      accessTokenEnc: encrypt(refreshed.access_token),
      expiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
      ...(refreshed.refresh_token && { refreshTokenEnc: encrypt(refreshed.refresh_token) }),
    },
  });

  return refreshed.access_token;
}

export interface EventInput {
  summary: string;
  description: string;
  date: string;
  startTime: string;
  endTime: string;
}

export async function createEvent(
  userId: string,
  appointmentId: string,
  input: EventInput
): Promise<CalendarResult<{ googleEventId: string }>> {
  if (!isConfigured()) return { ok: false, skipped: 'NOT_CONFIGURED' };

  try {
    const token = await accessTokenFor(userId);
    if (!token) return { ok: false, skipped: 'NOT_CONNECTED' };

    const connection = await prisma.calendarConnection.findUnique({ where: { userId } });
    const calendarId = connection?.googleCalendarId ?? 'primary';

    const response = await fetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: input.summary,
          description: input.description,
          start: {
            dateTime: clinicTimeToInstant(input.date, input.startTime).toISOString(),
            timeZone: CLINIC_TIMEZONE,
          },
          end: {
            dateTime: clinicTimeToInstant(input.date, input.endTime).toISOString(),
            timeZone: CLINIC_TIMEZONE,
          },
        }),
      }
    );

    if (!response.ok) {
      return { ok: false, error: `Google Calendar ${response.status}: ${(await response.text()).slice(0, 300)}` };
    }

    const event = (await response.json()) as { id: string };
    await prisma.calendarEvent.create({
      data: { appointmentId, userId, googleEventId: event.id, status: 'ACTIVE' },
    });

    return { ok: true, data: { googleEventId: event.id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deleteEventsForAppointment(
  appointmentId: string
): Promise<{ deleted: number; failed: number }> {
  if (!isConfigured()) return { deleted: 0, failed: 0 };

  const events = await prisma.calendarEvent.findMany({
    where: { appointmentId, status: 'ACTIVE' },
  });

  let deleted = 0;
  let failed = 0;

  for (const event of events) {
    try {
      const token = await accessTokenFor(event.userId);
      if (!token) {
        failed += 1;
        continue;
      }

      const connection = await prisma.calendarConnection.findUnique({
        where: { userId: event.userId },
      });
      const calendarId = connection?.googleCalendarId ?? 'primary';

      const response = await fetch(
        `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(
          event.googleEventId
        )}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
      );

      // 410 Gone means the user already removed it; treat as success.
      if (response.ok || response.status === 404 || response.status === 410) {
        await prisma.calendarEvent.update({
          where: { id: event.id },
          data: { status: 'DELETED' },
        });
        deleted += 1;
      } else {
        failed += 1;
        console.error(`[calendar] delete failed ${response.status} for event ${event.id}`);
      }
    } catch (err) {
      failed += 1;
      console.error('[calendar] delete threw:', err instanceof Error ? err.message : err);
    }
  }

  return { deleted, failed };
}

export async function disconnect(userId: string): Promise<void> {
  await prisma.calendarConnection.deleteMany({ where: { userId } });
}
