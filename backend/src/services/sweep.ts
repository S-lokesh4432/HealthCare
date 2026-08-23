import { NotificationStatus, NotificationType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { expireStaleHolds } from './booking';
import { retryEmail, sendEmail } from './email';
import { renderTemplate } from './email/templates';

export interface SweepReport {
  ranAt: string;
  holdsExpired: number;
  remindersDue: number;
  remindersSent: number;
  remindersFailed: number;
  retriesAttempted: number;
  retriesSucceeded: number;
  retriesExhausted: number;
}

const REMINDER_BATCH = 100;
const RETRY_BATCH = 100;

export async function runSweep(now: Date = new Date()): Promise<SweepReport> {
  const holdsExpired = await expireStaleHolds(now);

  const due = await prisma.medicationReminder.findMany({
    where: { status: NotificationStatus.PENDING, scheduledAt: { lte: now } },
    orderBy: { scheduledAt: 'asc' },
    take: REMINDER_BATCH,
    include: {
      prescription: {
        include: {
          appointment: {
            include: { patient: { select: { id: true, name: true, email: true } } },
          },
        },
      },
    },
  });

  let remindersSent = 0;
  let remindersFailed = 0;

  for (const reminder of due) {
    const patient = reminder.prescription.appointment.patient;
    const rendered = renderTemplate(NotificationType.MEDICATION_REMINDER, {
      patientName: patient.name,
      medicationName: reminder.prescription.medicationName,
      dosage: reminder.prescription.dosage,
      instructions: reminder.prescription.instructions ?? undefined,
    });

    const result = await sendEmail({
      userId: patient.id,
      to: patient.email,
      type: NotificationType.MEDICATION_REMINDER,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });

    await prisma.medicationReminder.update({
      where: { id: reminder.id },
      data: {
        status: result.ok ? NotificationStatus.SENT : NotificationStatus.FAILED,
        sentAt: result.ok ? new Date() : null,
      },
    });

    if (result.ok) remindersSent += 1;
    else remindersFailed += 1;
  }

  const retryable = await prisma.notificationLog.findMany({
    where: {
      status: NotificationStatus.FAILED,
      nextRetryAt: { lte: now },
    },
    orderBy: { nextRetryAt: 'asc' },
    take: RETRY_BATCH,
    select: { id: true, retryCount: true, maxRetries: true },
  });

  let retriesSucceeded = 0;
  let retriesExhausted = 0;

  for (const log of retryable) {
    if (log.retryCount >= log.maxRetries) {
      await prisma.notificationLog.update({
        where: { id: log.id },
        data: { status: NotificationStatus.PERMANENTLY_FAILED, nextRetryAt: null },
      });
      retriesExhausted += 1;
      continue;
    }

    const result = await retryEmail(log.id);
    if (result.ok) retriesSucceeded += 1;
    else if (log.retryCount + 1 >= log.maxRetries) retriesExhausted += 1;
  }

  return {
    ranAt: now.toISOString(),
    holdsExpired,
    remindersDue: due.length,
    remindersSent,
    remindersFailed,
    retriesAttempted: retryable.length,
    retriesSucceeded,
    retriesExhausted,
  };
}
