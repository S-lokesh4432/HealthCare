import { NotificationType } from '@prisma/client';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const wrap = (title: string, bodyHtml: string) => `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.6;color:#1a1a1a">
<div style="max-width:560px;margin:0 auto;padding:24px">
<h2 style="color:#1977cc;margin-bottom:16px">${title}</h2>
${bodyHtml}
<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0">
<p style="font-size:12px;color:#777">This is an automated message from the Clinic appointment system.</p>
</div></body></html>`;

const list = (items: string[]) =>
  items.length ? `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : '';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface TemplateData {
  patientName?: string;
  doctorName?: string;
  specialization?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  reason?: string;
  medicationName?: string;
  dosage?: string;
  instructions?: string;
  summary?: string;
  followUpSteps?: string[];
  medicationSchedule?: { medication: string; schedule: string }[];
}

export function renderTemplate(type: NotificationType, data: TemplateData): RenderedEmail {
  const when = `${data.date ?? ''} at ${data.startTime ?? ''}`.trim();
  const doctor = data.doctorName ?? 'your doctor';

  switch (type) {
    case NotificationType.BOOKING_CONFIRMATION: {
      const subject = `Appointment confirmed - ${when}`;
      const text = `Hello ${data.patientName ?? ''},\n\nYour appointment with ${doctor}${
        data.specialization ? ` (${data.specialization})` : ''
      } is confirmed for ${when}.\n\nPlease arrive 10 minutes early.`;
      return {
        subject,
        text,
        html: wrap(
          'Appointment confirmed',
          `<p>Hello ${escapeHtml(data.patientName ?? '')},</p>
           <p>Your appointment with <strong>${escapeHtml(doctor)}</strong>${
             data.specialization ? ` (${escapeHtml(data.specialization)})` : ''
           } is confirmed.</p>
           <p><strong>When:</strong> ${escapeHtml(when)}</p>
           <p>Please arrive 10 minutes early.</p>`
        ),
      };
    }

    case NotificationType.REMINDER: {
      const subject = `Reminder: appointment ${when}`;
      return {
        subject,
        text: `Reminder: you have an appointment with ${doctor} on ${when}.`,
        html: wrap(
          'Appointment reminder',
          `<p>Hello ${escapeHtml(data.patientName ?? '')},</p>
           <p>This is a reminder of your appointment with <strong>${escapeHtml(doctor)}</strong> on <strong>${escapeHtml(when)}</strong>.</p>`
        ),
      };
    }

    case NotificationType.CANCELLATION: {
      const subject = `Appointment cancelled - ${when}`;
      return {
        subject,
        text: `Your appointment with ${doctor} on ${when} has been cancelled.${
          data.reason ? ` Reason: ${data.reason}` : ''
        }`,
        html: wrap(
          'Appointment cancelled',
          `<p>Hello ${escapeHtml(data.patientName ?? '')},</p>
           <p>Your appointment with <strong>${escapeHtml(doctor)}</strong> on <strong>${escapeHtml(when)}</strong> has been cancelled.</p>
           ${data.reason ? `<p><strong>Reason:</strong> ${escapeHtml(data.reason)}</p>` : ''}
           <p>Please book a new appointment at your convenience.</p>`
        ),
      };
    }

    case NotificationType.LEAVE_NOTICE: {
      const subject = `Appointment cancelled - ${doctor} unavailable on ${data.date ?? ''}`;
      return {
        subject,
        text: `${doctor} is unavailable on ${data.date ?? ''}, so your appointment at ${
          data.startTime ?? ''
        } has been cancelled.${data.reason ? ` Reason: ${data.reason}` : ''} Please rebook.`,
        html: wrap(
          'Your appointment was cancelled',
          `<p>Hello ${escapeHtml(data.patientName ?? '')},</p>
           <p><strong>${escapeHtml(doctor)}</strong> is unavailable on <strong>${escapeHtml(
             data.date ?? ''
           )}</strong>, so your appointment at <strong>${escapeHtml(
             data.startTime ?? ''
           )}</strong> has been cancelled.</p>
           ${data.reason ? `<p><strong>Reason:</strong> ${escapeHtml(data.reason)}</p>` : ''}
           <p>We are sorry for the inconvenience. Please book another slot.</p>`
        ),
      };
    }

    case NotificationType.MEDICATION_REMINDER: {
      const subject = `Medication reminder: ${data.medicationName ?? ''}`;
      return {
        subject,
        text: `Time to take ${data.medicationName ?? ''} (${data.dosage ?? ''}).${
          data.instructions ? ` ${data.instructions}` : ''
        }`,
        html: wrap(
          'Medication reminder',
          `<p>Hello ${escapeHtml(data.patientName ?? '')},</p>
           <p>It is time to take <strong>${escapeHtml(data.medicationName ?? '')}</strong> (${escapeHtml(
             data.dosage ?? ''
           )}).</p>
           ${data.instructions ? `<p>${escapeHtml(data.instructions)}</p>` : ''}`
        ),
      };
    }
  }
}

export function renderPostVisitSummary(data: TemplateData): RenderedEmail {
  return {
    subject: `Your visit summary - ${data.date ?? ''}`,
    text: `${data.summary ?? ''}\n\nMedication:\n${(data.medicationSchedule ?? [])
      .map((m) => `- ${m.medication}: ${m.schedule}`)
      .join('\n')}\n\nFollow-up:\n${(data.followUpSteps ?? []).map((s) => `- ${s}`).join('\n')}`,
    html: wrap(
      'Your visit summary',
      `<p>Hello ${escapeHtml(data.patientName ?? '')},</p>
       <p>${escapeHtml(data.summary ?? '')}</p>
       ${
         data.medicationSchedule?.length
           ? `<h3>Medication schedule</h3><ul>${data.medicationSchedule
               .map(
                 (m) =>
                   `<li><strong>${escapeHtml(m.medication)}</strong>: ${escapeHtml(m.schedule)}</li>`
               )
               .join('')}</ul>`
           : ''
       }
       ${data.followUpSteps?.length ? `<h3>Follow-up steps</h3>${list(data.followUpSteps)}` : ''}`
    ),
  };
}
