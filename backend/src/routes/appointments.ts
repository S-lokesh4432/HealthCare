import { Router } from 'express';
import { AppointmentStatus, NotificationType, Role, SummaryStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { validateBody } from '../middleware/validate';
import { requireAuth, requireRole } from '../middleware/auth';
import { formatDateOnly, isValidDateString, isValidTimeString } from '../lib/time';
import { holdSlotWithReclaim } from '../services/booking';
import { generatePostVisitSummary, generatePreVisitSummary } from '../services/llm';
import { sendEmail } from '../services/email';
import { renderPostVisitSummary, renderTemplate } from '../services/email/templates';
import { createEvent, deleteEventsForAppointment } from '../services/calendar/google';
import { scheduleRemindersForPrescription } from '../services/reminders';

const router = Router();
router.use(requireAuth);

const holdSchema = z.object({
  doctorId: z.string().min(1),
  date: z.string().refine(isValidDateString, 'Expected YYYY-MM-DD'),
  startTime: z.string().refine(isValidTimeString, 'Expected HH:MM'),
});

const confirmSchema = z.object({
  symptomText: z.string().min(3, 'Please describe your symptoms').max(4000),
});

const notesSchema = z.object({
  postVisitNotes: z.string().min(3).max(8000),
  prescriptions: z
    .array(
      z.object({
        medicationName: z.string().min(1),
        dosage: z.string().min(1),
        frequencyPerDay: z.number().int().min(1).max(6),
        durationDays: z.number().int().min(1).max(365),
        instructions: z.string().max(500).optional(),
      })
    )
    .default([]),
});

const summaryEditSchema = z.object({
  summary: z.string().min(1),
  medicationSchedule: z.array(z.object({ medication: z.string(), schedule: z.string() })),
  followUpSteps: z.array(z.string()),
});

const summaryStatusOf = (status: 'OK' | 'DEGRADED' | 'FAILED') =>
  status === 'OK'
    ? SummaryStatus.OK
    : status === 'DEGRADED'
      ? SummaryStatus.DEGRADED
      : SummaryStatus.FAILED;

async function loadForDoctor(appointmentId: string, userId: string) {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      doctor: { select: { id: true, userId: true, specialization: true, user: { select: { name: true } } } },
      patient: { select: { id: true, name: true, email: true } },
      prescriptions: true,
    },
  });
  if (!appointment) throw notFound('Appointment not found');
  if (appointment.doctor.userId !== userId) throw forbidden();
  return appointment;
}

router.post(
  '/hold',
  requireRole(Role.PATIENT),
  validateBody(holdSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof holdSchema>;
    const appointment = await holdSlotWithReclaim({ ...body, patientId: req.auth!.userId });

    res.status(201).json({
      id: appointment.id,
      doctorId: appointment.doctorId,
      date: formatDateOnly(appointment.date),
      startTime: appointment.startTime,
      endTime: appointment.endTime,
      status: appointment.status,
      holdExpiresAt: appointment.holdExpiresAt,
    });
  })
);

router.post(
  '/:id/confirm',
  requireRole(Role.PATIENT),
  validateBody(confirmSchema),
  asyncHandler(async (req, res) => {
    const { symptomText } = req.body as z.infer<typeof confirmSchema>;

    const appointment = await prisma.appointment.findUnique({
      where: { id: req.params.id },
      include: {
        doctor: {
          select: {
            id: true,
            userId: true,
            specialization: true,
            user: { select: { name: true, email: true } },
          },
        },
        patient: { select: { id: true, name: true, email: true } },
      },
    });

    if (!appointment) throw notFound('Appointment not found');
    if (appointment.patientId !== req.auth!.userId) throw forbidden();
    if (appointment.status === AppointmentStatus.CONFIRMED) {
      throw conflict('This appointment is already confirmed', 'ALREADY_CONFIRMED');
    }
    if (appointment.status !== AppointmentStatus.HELD) {
      throw conflict('This hold is no longer active', 'HOLD_NOT_ACTIVE');
    }
    if (!appointment.holdExpiresAt || appointment.holdExpiresAt.getTime() <= Date.now()) {
      throw conflict('Your hold expired, please pick the slot again', 'HOLD_EXPIRED');
    }

    const summary = await generatePreVisitSummary(symptomText);

    const confirmed = await prisma.appointment.update({
      where: { id: appointment.id },
      data: {
        status: AppointmentStatus.CONFIRMED,
        holdExpiresAt: null,
        symptomText,
        preVisitSummary: summary.data ?? undefined,
        preVisitStatus: summaryStatusOf(summary.status),
      },
    });

    const dateString = formatDateOnly(appointment.date);
    const rendered = renderTemplate(NotificationType.BOOKING_CONFIRMATION, {
      patientName: appointment.patient.name,
      doctorName: appointment.doctor.user.name,
      specialization: appointment.doctor.specialization,
      date: dateString,
      startTime: appointment.startTime,
      endTime: appointment.endTime,
    });

    const email = await sendEmail({
      userId: appointment.patient.id,
      to: appointment.patient.email,
      type: NotificationType.BOOKING_CONFIRMATION,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });

    const eventInput = {
      summary: `Appointment: ${appointment.doctor.user.name} (${appointment.doctor.specialization})`,
      description: `Booked via the clinic portal.`,
      date: dateString,
      startTime: appointment.startTime,
      endTime: appointment.endTime,
    };

    const [patientEvent, doctorEvent] = await Promise.all([
      createEvent(appointment.patient.id, appointment.id, eventInput),
      createEvent(appointment.doctor.userId, appointment.id, {
        ...eventInput,
        summary: `Appointment: ${appointment.patient.name}`,
      }),
    ]);

    res.json({
      id: confirmed.id,
      status: confirmed.status,
      date: dateString,
      startTime: confirmed.startTime,
      endTime: confirmed.endTime,
      preVisitStatus: confirmed.preVisitStatus,
      preVisitSummary: confirmed.preVisitSummary,
      notifications: { emailSent: email.ok, emailError: email.error ?? null },
      calendar: {
        patient: patientEvent.ok ? 'CREATED' : (patientEvent.skipped ?? 'FAILED'),
        doctor: doctorEvent.ok ? 'CREATED' : (doctorEvent.skipped ?? 'FAILED'),
      },
    });
  })
);

router.get(
  '/mine',
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;

    const where =
      role === Role.PATIENT
        ? { patientId: userId }
        : role === Role.DOCTOR
          ? { doctor: { userId } }
          : {};

    const appointments = await prisma.appointment.findMany({
      where,
      orderBy: [{ date: 'desc' }, { startTime: 'asc' }],
      take: 200,
      include: {
        patient: { select: { id: true, name: true, email: true } },
        doctor: {
          select: { id: true, specialization: true, user: { select: { name: true } } },
        },
        prescriptions: true,
      },
    });

    res.json(
      appointments.map((a) => ({
        ...a,
        date: formatDateOnly(a.date),
        doctorName: a.doctor.user.name,
      }))
    );
  })
);

router.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const appointment = await prisma.appointment.findUnique({
      where: { id: req.params.id },
      include: {
        doctor: { select: { userId: true, specialization: true, user: { select: { name: true } } } },
        patient: { select: { id: true, name: true, email: true } },
      },
    });
    if (!appointment) throw notFound('Appointment not found');

    const { userId, role } = req.auth!;
    const allowed =
      role === Role.ADMIN ||
      appointment.patientId === userId ||
      appointment.doctor.userId === userId;
    if (!allowed) throw forbidden();

    if (
      appointment.status === AppointmentStatus.CANCELLED ||
      appointment.status === AppointmentStatus.COMPLETED
    ) {
      throw conflict(`Appointment is already ${appointment.status.toLowerCase()}`, 'NOT_CANCELLABLE');
    }

    await prisma.appointment.update({
      where: { id: appointment.id },
      data: { status: AppointmentStatus.CANCELLED, holdExpiresAt: null },
    });

    const calendar = await deleteEventsForAppointment(appointment.id);

    const dateString = formatDateOnly(appointment.date);
    const rendered = renderTemplate(NotificationType.CANCELLATION, {
      patientName: appointment.patient.name,
      doctorName: appointment.doctor.user.name,
      date: dateString,
      startTime: appointment.startTime,
    });

    const email = await sendEmail({
      userId: appointment.patient.id,
      to: appointment.patient.email,
      type: NotificationType.CANCELLATION,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });

    res.json({
      cancelled: true,
      calendarEventsDeleted: calendar.deleted,
      calendarDeletionsFailed: calendar.failed,
      notification: { sent: email.ok, error: email.error ?? null },
    });
  })
);

router.post(
  '/:id/notes',
  requireRole(Role.DOCTOR),
  validateBody(notesSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof notesSchema>;
    const appointment = await loadForDoctor(req.params.id, req.auth!.userId);

    if (appointment.status === AppointmentStatus.CANCELLED) {
      throw conflict('Cannot add notes to a cancelled appointment', 'APPOINTMENT_CANCELLED');
    }
    if (appointment.status === AppointmentStatus.COMPLETED) {
      // Without this, a double-click (or a retried request) would create a
      // second set of prescriptions and double-schedule medication reminders.
      throw conflict(
        'This visit already has notes. Edit the summary instead of resubmitting.',
        'ALREADY_COMPLETED'
      );
    }

    const summary = await generatePostVisitSummary(body.postVisitNotes);

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.appointment.update({
        where: { id: appointment.id },
        data: {
          postVisitNotes: body.postVisitNotes,
          postVisitSummary: summary.data ?? undefined,
          postVisitStatus: summaryStatusOf(summary.status),
          status: AppointmentStatus.COMPLETED,
        },
      });

      for (const prescription of body.prescriptions) {
        const created = await tx.prescription.create({
          data: {
            appointmentId: appointment.id,
            medicationName: prescription.medicationName,
            dosage: prescription.dosage,
            frequencyPerDay: prescription.frequencyPerDay,
            durationDays: prescription.durationDays,
            instructions: prescription.instructions ?? null,
          },
        });

        await scheduleRemindersForPrescription(tx, created, appointment.patientId, appointment.date);
      }

      return result;
    });

    res.json({
      id: updated.id,
      status: updated.status,
      postVisitStatus: updated.postVisitStatus,
      postVisitSummary: updated.postVisitSummary,
      summaryError: summary.error ?? null,
    });
  })
);

router.patch(
  '/:id/summary',
  requireRole(Role.DOCTOR),
  validateBody(summaryEditSchema),
  asyncHandler(async (req, res) => {
    const appointment = await loadForDoctor(req.params.id, req.auth!.userId);

    const updated = await prisma.appointment.update({
      where: { id: appointment.id },
      data: {
        postVisitSummary: req.body as z.infer<typeof summaryEditSchema>,
        postVisitStatus: SummaryStatus.OK,
      },
    });

    res.json({ id: updated.id, postVisitSummary: updated.postVisitSummary });
  })
);

router.post(
  '/:id/summary/send',
  requireRole(Role.DOCTOR),
  asyncHandler(async (req, res) => {
    const appointment = await loadForDoctor(req.params.id, req.auth!.userId);

    if (!appointment.postVisitSummary) {
      throw badRequest(
        'There is no summary to send. Generate or write one first.',
        'NO_SUMMARY'
      );
    }

    const summary = appointment.postVisitSummary as z.infer<typeof summaryEditSchema>;
    const rendered = renderPostVisitSummary({
      patientName: appointment.patient.name,
      date: formatDateOnly(appointment.date),
      summary: summary.summary,
      medicationSchedule: summary.medicationSchedule,
      followUpSteps: summary.followUpSteps,
    });

    const email = await sendEmail({
      userId: appointment.patient.id,
      to: appointment.patient.email,
      type: NotificationType.REMINDER,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });

    res.json({ sent: email.ok, error: email.error ?? null, logId: email.logId });
  })
);

export default router;
