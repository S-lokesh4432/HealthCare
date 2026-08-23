import { ZodSchema } from 'zod';
import { env } from '../../lib/env';
import { postVisitSchema, preVisitSchema, PostVisitSummary, PreVisitSummary } from './schemas';
import { PRE_VISIT_SYSTEM, PRE_VISIT_USER, POST_VISIT_SYSTEM, POST_VISIT_USER } from './prompts';

export type LLMStatus = 'OK' | 'DEGRADED' | 'FAILED';

export interface LLMResult<T> {
  data: T | null;
  status: LLMStatus;
  error?: string;
}

const TIMEOUT_MS = 10_000;

// gemini-2.0-flash from the brief is retired; 3.x returns 404 on the free tier.
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
const XAI_MODEL = process.env.XAI_MODEL ?? 'grok-4-fast';

interface ProviderOutcome {
  text: string | null;
  error?: string;
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('No JSON object found in model output');
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function callGemini(system: string, user: string): Promise<ProviderOutcome> {
  if (!env.geminiApiKey) return { text: null, error: 'GEMINI_API_KEY not configured' };

  try {
    return await withTimeout(async (signal) => {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': env.geminiApiKey!,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: user }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
          }),
          signal,
        }
      );

      if (!response.ok) {
        return {
          text: null,
          error: `Gemini ${response.status}: ${(await response.text()).slice(0, 300)}`,
        };
      }

      const payload = (await response.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
      return text ? { text } : { text: null, error: 'Gemini returned no text content' };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { text: null, error: message.includes('abort') ? `Gemini timeout after ${TIMEOUT_MS}ms` : message };
  }
}

async function callXai(system: string, user: string): Promise<ProviderOutcome> {
  if (!env.xaiApiKey) return { text: null, error: 'XAI_API_KEY not configured' };

  try {
    return await withTimeout(async (signal) => {
      const response = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.xaiApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: XAI_MODEL,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal,
      });

      if (!response.ok) {
        return {
          text: null,
          error: `xAI ${response.status}: ${(await response.text()).slice(0, 300)}`,
        };
      }

      const payload = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const text = payload.choices?.[0]?.message?.content;
      return text ? { text } : { text: null, error: 'xAI returned no message content' };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { text: null, error: message.includes('abort') ? `xAI timeout after ${TIMEOUT_MS}ms` : message };
  }
}

async function generate<T>(
  system: string,
  user: string,
  schema: ZodSchema<T>
): Promise<LLMResult<T>> {
  const errors: string[] = [];

  const providers: { name: string; call: () => Promise<ProviderOutcome>; degraded: boolean }[] = [
    { name: 'gemini', call: () => callGemini(system, user), degraded: false },
    { name: 'xai', call: () => callXai(system, user), degraded: true },
  ];

  for (const provider of providers) {
    const outcome = await provider.call();

    if (!outcome.text) {
      errors.push(`${provider.name}: ${outcome.error ?? 'unknown error'}`);
      continue;
    }

    try {
      const parsed = schema.safeParse(extractJson(outcome.text));
      if (!parsed.success) {
        errors.push(
          `${provider.name}: schema mismatch (${parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')})`
        );
        continue;
      }
      return { data: parsed.data, status: provider.degraded ? 'DEGRADED' : 'OK' };
    } catch (err) {
      errors.push(`${provider.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { data: null, status: 'FAILED', error: errors.join(' | ') };
}

export function generatePreVisitSummary(symptoms: string): Promise<LLMResult<PreVisitSummary>> {
  return generate(PRE_VISIT_SYSTEM, PRE_VISIT_USER(symptoms), preVisitSchema);
}

export function generatePostVisitSummary(notes: string): Promise<LLMResult<PostVisitSummary>> {
  return generate(POST_VISIT_SYSTEM, POST_VISIT_USER(notes), postVisitSchema);
}
