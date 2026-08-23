import { z } from 'zod';

export const preVisitSchema = z.object({
  urgency: z.enum(['Low', 'Medium', 'High']),
  chiefComplaint: z.string().min(1),
  suggestedQuestions: z.array(z.string().min(1)).min(1).max(5),
});

export const postVisitSchema = z.object({
  summary: z.string().min(1),
  medicationSchedule: z.array(
    z.object({ medication: z.string().min(1), schedule: z.string().min(1) })
  ),
  followUpSteps: z.array(z.string().min(1)),
});

export type PreVisitSummary = z.infer<typeof preVisitSchema>;
export type PostVisitSummary = z.infer<typeof postVisitSchema>;
