import { AppointmentStatus, NotificationType, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { conflict } from '../lib/errors';
import { formatDateOnly } from '../lib/time';
import { sendEmail } from './email';
import { renderTemplate } from './email/templates';
import { deleteEventsForAppointment } from './calendar/google';

export interface LeaveResult {
  leaveId: string;
  date: string;
  cancelledAppointments: number;
  patientsNotified: number;
  notificationsFailed: number;
  calendarEventsDeleted: number;
  calendarDeletionsFailed: number;
}

interface TransactionResult {
  leave: { id: string };
  affected: {
    id: string;
    date: Date;
    startTime: string;
    patient: { id: string; name: string; email: string };
    doctor: { specialization: string; user: { name: string } };
  }[];
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * Cancellation and leave creation share one transaction so a partial failure
 * cannot leave a doctor on leave with live appointments still on the books.
 * Email and calendar calls run afterwards: they are external and slow, and a
 * failure there must not roll back the cancellation.
 */
export async function applyLeave(
  doctorId: string,
  date: Date,
  reason: string | null
): Promise<LeaveResult> {
  const existing = await prisma.leave.findUnique({ where: { doctorId_date: { doctorId, date } } });
  if (existing) throw conflict('Leave already recorded for that date', 'LEAVE_EXISTS');

  let result: TransactionResult;
  try {
    result = await prisma.$transaction(async (tx) => {
      const created = await tx.leave.create({ data: { doctorId, date, reason } });

      const toCancel = await tx.appointment.findMany({
        where: {
          doctorId,
          date,
          status: { in: [AppointmentStatus.CONFIRMED, AppointmentStatus.HELD] },
        },
        include: {
          patient: { select: { id: true, name: true, email: true } },
          doctor: { select: { specialization: true, user: { select: { name: true } } } },
        },
      });

      if (toCancel.length > 0) {
        await tx.appointment.updateMany({
          where: { id: { in: toCancel.map((a) => a.id) } },
          data: { status: AppointmentStatus.CANCELLED, holdExpiresAt: null },
        });
      }

      return { leave: created, affected: toCancel };
    });
  } catch (err) {
    // The existence check above is TOCTOU-racy under concurrent admin
    // requests; @@unique([doctorId, date]) is the actual guarantee, so a
    // P2002 here still means "already on leave," not a server error.
    if (isUniqueViolation(err)) {
      throw conflict('Leave already recorded for that date', 'LEAVE_EXISTS');
    }
    throw err;
  }

  const { leave, affected } = result;

  let patientsNotified = 0;
  let notificationsFailed = 0;
  let calendarEventsDeleted = 0;
  let calendarDeletionsFailed = 0;

  for (const appointment of affected) {
    const calendarResult = await deleteEventsForAppointment(appointment.id);
    calendarEventsDeleted += calendarResult.deleted;
    calendarDeletionsFailed += calendarResult.failed;

    const rendered = renderTemplate(NotificationType.LEAVE_NOTICE, {
      patientName: appointment.patient.name,
      doctorName: appointment.doctor.user.name,
      specialization: appointment.doctor.specialization,
      date: formatDateOnly(appointment.date),
      startTime: appointment.startTime,
      reason: reason ?? undefined,
    });

    const sent = await sendEmail({
      userId: appointment.patient.id,
      to: appointment.patient.email,
      type: NotificationType.LEAVE_NOTICE,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });

    if (sent.ok) patientsNotified += 1;
    else notificationsFailed += 1;
  }

  return {
    leaveId: leave.id,
    date: formatDateOnly(date),
    cancelledAppointments: affected.length,
    patientsNotified,
    notificationsFailed,
    calendarEventsDeleted,
    calendarDeletionsFailed,
  };
}
