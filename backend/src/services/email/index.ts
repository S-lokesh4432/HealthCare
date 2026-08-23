import { NotificationStatus, NotificationType } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env } from '../../lib/env';

export const RETRY_BACKOFF_MINUTES = [2, 10, 30, 120, 360];

export function nextRetryDelayMinutes(retryCount: number): number {
  return RETRY_BACKOFF_MINUTES[Math.min(retryCount, RETRY_BACKOFF_MINUTES.length - 1)];
}

export interface SendResult {
  ok: boolean;
  logId: string;
  error?: string;
}

interface DeliverResult {
  ok: boolean;
  error?: string;
}

async function deliver(to: string, subject: string, html: string, text: string): Promise<DeliverResult> {
  if (!env.resendApiKey || !env.emailFrom) {
    return { ok: false, error: 'Email provider not configured (RESEND_API_KEY / EMAIL_FROM missing)' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: env.emailFrom, to: [to], subject, html, text }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      return { ok: false, error: `Resend ${response.status}: ${body.slice(0, 400)}` };
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message === 'The operation was aborted.' ? 'Timeout after 15s' : message };
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendEmail(params: {
  userId: string;
  to: string;
  type: NotificationType;
  subject: string;
  html: string;
  text: string;
}): Promise<SendResult> {
  const log = await prisma.notificationLog.create({
    data: {
      userId: params.userId,
      type: params.type,
      recipient: params.to,
      subject: params.subject,
      bodyHtml: params.html,
      bodyText: params.text,
      status: NotificationStatus.PENDING,
    },
  });

  const result = await deliver(params.to, params.subject, params.html, params.text);

  if (result.ok) {
    await prisma.notificationLog.update({
      where: { id: log.id },
      data: { status: NotificationStatus.SENT, lastError: null, nextRetryAt: null },
    });
    return { ok: true, logId: log.id };
  }

  await prisma.notificationLog.update({
    where: { id: log.id },
    data: {
      status: NotificationStatus.FAILED,
      lastError: result.error,
      nextRetryAt: new Date(Date.now() + nextRetryDelayMinutes(0) * 60_000),
    },
  });
  return { ok: false, logId: log.id, error: result.error };
}

export async function retryEmail(logId: string): Promise<SendResult> {
  const log = await prisma.notificationLog.findUnique({ where: { id: logId } });
  if (!log) return { ok: false, logId, error: 'Notification log not found' };

  const result = await deliver(log.recipient, log.subject, log.bodyHtml, log.bodyText);
  const retryCount = log.retryCount + 1;

  if (result.ok) {
    await prisma.notificationLog.update({
      where: { id: log.id },
      data: { status: NotificationStatus.SENT, retryCount, lastError: null, nextRetryAt: null },
    });
    return { ok: true, logId: log.id };
  }

  const exhausted = retryCount >= log.maxRetries;
  await prisma.notificationLog.update({
    where: { id: log.id },
    data: {
      status: exhausted ? NotificationStatus.PERMANENTLY_FAILED : NotificationStatus.FAILED,
      retryCount,
      lastError: result.error,
      nextRetryAt: exhausted
        ? null
        : new Date(Date.now() + nextRetryDelayMinutes(retryCount) * 60_000),
    },
  });
  return { ok: false, logId: log.id, error: result.error };
}
