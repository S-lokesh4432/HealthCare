# Healthcare Appointment & Follow-up Manager — Backend

Express + TypeScript REST API, PostgreSQL (Neon) via Prisma, JWT auth. The
frontend is a separate static site in `../frontend` — this service only
serves JSON under `/api/*` (plus `/health`).

## Stack

| Area | Choice |
|---|---|
| Runtime | Node 22, Express 4, TypeScript (strict) |
| Database | PostgreSQL (Neon in prod, local Docker for dev) via Prisma |
| Auth | Custom JWT (bcrypt + jsonwebtoken), `Authorization: Bearer <token>` |
| LLM | Gemini (`gemini-2.5-flash`) primary, xAI Grok (`grok-4-fast`) fallback |
| Email | Resend |
| Calendar | Google Calendar API v3, OAuth 2.0 authorization-code flow |
| Hosting | Vercel serverless (Express wrapped as a single catch-all function) |

Auth.js/NextAuth was dropped from the original spec because it's Next.js-only
and this project splits frontend/backend into separate origins.

## Setup

```bash
cd backend
npm install
cp .env.example .env   # fill in values, see below
npx prisma migrate deploy   # applies schema + the partial unique index
npx prisma db seed          # 1 admin + 3 demo doctors, see prisma/seed.ts
npm run dev                 # http://localhost:4000
```

Local Postgres without Neon:
```bash
docker run -d --name healthcare-pg -e POSTGRES_USER=healthcare \
  -e POSTGRES_PASSWORD=healthcare_dev_local -e POSTGRES_DB=healthcare \
  -p 5433:5432 postgres:16-alpine
# DATABASE_URL=postgresql://healthcare:healthcare_dev_local@localhost:5433/healthcare
```

Serve the frontend statically from a real origin (not `file://`, so CORS
behaves) and point `CORS_ORIGIN` at it:
```bash
cd ../frontend && python3 -m http.server 5500
```

Run tests (needs a real Postgres — no DB mocking):
```bash
npm test
```

## Environment variables

See `.env.example`. Everything the app needs to *run* has a sane default or
degrades explicitly (see "Missing credentials" below) except `DATABASE_URL`,
`JWT_SECRET`, and `CRON_SECRET`, which are required.

- `GEMINI_API_KEY` / `XAI_API_KEY` — LLM providers. `GEMINI_MODEL` /
  `XAI_MODEL` env vars override the defaults if the pinned model names
  retire again (they already have once — see prompts doc below).
- `RESEND_API_KEY` / `EMAIL_FROM` — email. Get a key at resend.com; their
  test domain works for development without domain verification.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` /
  `ENCRYPTION_KEY` — Google Calendar. See the setup steps below.
- `CRON_SECRET` — required `Authorization: Bearer <secret>` header on
  `/api/cron/sweep`.

### Missing credentials degrade explicitly, never silently

`GET /health` reports which integrations are configured:
```json
{"status":"ok","db":"connected","features":{"llm":true,"email":false,"calendar":false,"cron":true}}
```
With no LLM keys, summaries return `status: "FAILED"` and `data: null` — the
frontend shows "AI summary unavailable" rather than fabricating text. With no
Resend key, `sendEmail` writes a `FAILED` `NotificationLog` row with the real
error and the booking still succeeds. With no Google credentials, calendar
creation returns `skipped: "NOT_CONFIGURED"` and the booking still succeeds.

## Deploying to Vercel + Neon

Use Neon's **pooled** connection string (the one with `-pooler` in the
hostname) for `DATABASE_URL`, and the direct one for `DIRECT_URL` (Prisma
needs a direct connection for migrations, pgbouncer's transaction pooling
mode doesn't support them). Each serverless invocation can open its own
connection; without pooling, moderate concurrent traffic exhausts Postgres's
connection limit. If you still see connection errors under load, add
`?connection_limit=1` to `DATABASE_URL` — the documented fix for Prisma
on serverless.

## Google Calendar setup

1. console.cloud.google.com → new project → enable "Google Calendar API".
2. "OAuth consent screen" → External → add yourself as a test user (consent
   screens stay in testing mode without Google review, which is enough for
   personal accounts to connect).
3. "Credentials" → "Create OAuth client ID" → Web application → authorized
   redirect URI: `http://localhost:4000/api/calendar/callback` (and your
   deployed URL's equivalent).
4. Copy the Client ID/Secret into `.env`, set `GOOGLE_REDIRECT_URI` to match
   exactly what you registered.
5. `ENCRYPTION_KEY`: `openssl rand -hex 32`.

A user connects their calendar from their dashboard ("Connect Google
Calendar" button → `GET /api/calendar/connect` → opens the Google consent
screen → callback stores encrypted tokens). This is independent of login —
connecting calendar is a separate consent, not part of authentication.

## API reference

All routes except `/health`, `/api/auth/register`, `/api/auth/login`, and
`/api/calendar/callback` require `Authorization: Bearer <jwt>`.

### Auth
| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/api/auth/register` | — | Creates a PATIENT account |
| POST | `/api/auth/login` | — | |
| GET | `/api/auth/me` | any | |

### Doctors (public listing, auth for availability)
| Method | Path | Role |
|---|---|---|
| GET | `/api/doctors?specialization=&q=` | any |
| GET | `/api/doctors/specializations` | any |
| GET | `/api/doctors/:id/availability?date=YYYY-MM-DD` | any |

### Appointments
| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/api/appointments/hold` | PATIENT | `409 SLOT_TAKEN` on collision |
| POST | `/api/appointments/:id/confirm` | PATIENT | triggers LLM + email + calendar |
| GET | `/api/appointments/mine` | any | scoped to caller |
| POST | `/api/appointments/:id/cancel` | patient/doctor/admin | |
| POST | `/api/appointments/:id/notes` | DOCTOR | notes + prescriptions, triggers LLM |
| PATCH | `/api/appointments/:id/summary` | DOCTOR | edit AI summary before sending |
| POST | `/api/appointments/:id/summary/send` | DOCTOR | |

### Admin
| Method | Path |
|---|---|
| POST / GET / PATCH | `/api/admin/doctors[/:id]` |
| POST | `/api/admin/doctors/:id/leave` |
| DELETE | `/api/admin/doctors/:id/leave/:date` |
| GET | `/api/admin/appointments` |
| GET | `/api/admin/notifications?failed=true` |

### Calendar / Cron
| Method | Path | Notes |
|---|---|---|
| GET | `/api/calendar/status` \| `/connect` | auth required |
| GET | `/api/calendar/callback` | OAuth redirect target, no auth header (state carries identity) |
| DELETE | `/api/calendar` | disconnect |
| ALL | `/api/cron/sweep` | `Authorization: Bearer $CRON_SECRET` |

## LLM prompts

Both providers get the same system/user prompt pair and must return strict
JSON, validated with zod before being trusted.

**Pre-visit** (`src/services/llm/prompts.ts`):
```
System: You are a clinical intake assistant. Return ONLY valid JSON matching
this schema: { "urgency": "Low"|"Medium"|"High", "chiefComplaint": string,
"suggestedQuestions": [string, string, string] } ...

User: Analyse these symptoms and return: urgency level, chief complaint,
and three suggested questions for the doctor. Symptoms: <symptoms>
```

**Post-visit**:
```
System: You convert clinical notes into a patient-friendly summary. Return
ONLY valid JSON: { "summary": string, "medicationSchedule": [...],
"followUpSteps": [string] } ...

User: Convert these clinical notes into a patient-friendly summary with
medication schedule and follow-up steps: <notes>
```

Call flow: Gemini (10s timeout) → on error/timeout/schema-mismatch, xAI Grok
(10s timeout) → on both failing, `{ data: null, status: 'FAILED' }`. A
schema mismatch is treated as a failure, not a partial save.

**Model names drift.** `gemini-2.0-flash` from the original spec and
`grok-2-latest` both 404 as of 2026-08; the code defaults to
`gemini-2.5-flash` / `grok-4-fast`, overridable via `GEMINI_MODEL` /
`XAI_MODEL` without a code change. Gemini was verified live; xAI Grok
authenticates but has never actually returned a summary in this
environment — the API key provided during development has no credits
(`403 permission-denied`, xAI has no free tier). The fallback code path is
implemented and typechecked but **not verified to work** until a funded
xAI key or a Groq key is supplied.

## System design (≤800 words)

**Double-booking prevention.** The guarantee lives in Postgres, not
application code: `CREATE UNIQUE INDEX appointment_slot_unique ON
"Appointment" ("doctorId","date","startTime") WHERE status IN
('HELD','CONFIRMED')`. Two concurrent `INSERT`s for the same slot are
serialized by the database's own index maintenance — one commits, the other
raises `23505 unique_violation` (Prisma: `P2002`), regardless of
app-level races, retries, or serverless cold starts. The API's only job
is mapping that error to a clean `409`. This was worth being paranoid about:
Prisma reports the violated *columns* in `error.meta.target`
(`['doctorId','date','startTime']`), not the index name — matching on the
index name alone silently failed to catch the error, and it escaped as a raw
500 under exactly the concurrent-load scenario the safeguard exists for. The
integration test (`tests/integration/concurrency.test.ts`, 10 simultaneous
holds → exactly 1 succeeds, 9 get `409 SLOT_TAKEN`) caught this before it
shipped; `isSlotTakenError` now matches on the field set, not the name.
CANCELLED/EXPIRED/COMPLETED/NO_SHOW are excluded from the index so a freed
slot becomes bookable again immediately.

**Slot hold mechanism.** A hold is a normal `Appointment` row with
`status='HELD'` and `holdExpiresAt = now() + 7min`, created through the same
unique index as a confirmed booking — so a held slot is genuinely
unavailable to everyone else immediately, not just after some background
job runs. Correctness never depends on a cron firing on time: every
availability query filters `status='HELD' AND holdExpiresAt > now()`, so an
expired hold reads as available the instant it expires, cron or no cron. The
one place this needed extra care is the *write* path: an expired-but-unswept
HELD row still occupies the unique index, so a second patient's hold attempt
can legitimately collide with a dead row. `holdSlotWithReclaim` handles
this — on a `SLOT_TAKEN` conflict, it attempts to flip the specific expired
row to `EXPIRED` and retries the insert once; if that reclaim affects zero
rows (the conflict was a live hold, not a stale one), the original 409
stands. A daily Vercel cron additionally sweeps all expired holds for data
hygiene, but it is a cleanup job, not a correctness dependency.

**Leave conflict handling.** `applyLeave` splits into two phases
deliberately. The database part — recording the `Leave` row and cancelling
every `CONFIRMED`/`HELD` appointment on that date — runs inside one Prisma
transaction, so a crash mid-cancellation can never leave the doctor marked
on leave with live bookings still standing. Email and calendar-deletion
calls happen *after* the transaction commits: they're slow, external, and
their failure must not roll back a cancellation that already succeeded from
the database's point of view. Each notification attempt is logged
individually, and the response to the admin reports exact counts —
`cancelledAppointments`, `patientsNotified`, `notificationsFailed` — never a
bare "success" that could hide a partially-notified patient list.

**Notification failure handling.** `sendEmail` writes a `NotificationLog`
row with `status='PENDING'` *before* attempting delivery, then updates it to
`SENT` or `FAILED` with the real provider error in `lastError`. Failed rows
get `nextRetryAt` set via an increasing backoff (2/10/30/120/360 minutes);
past `maxRetries` (default 5), status becomes `PERMANENTLY_FAILED` and stops
being retried — visible on the admin dashboard's failed-notifications view,
never silently dropped and never retried forever. The daily
`/api/cron/sweep` endpoint processes everything currently due — all
`MedicationReminder`s with `scheduledAt <= now()` and all retryable
`NotificationLog` rows — not just "today's" items, so a cron that missed a
day doesn't lose work, only delays it. Because Vercel's free-tier cron is
daily-only, medication reminders can in the worst case run up to ~24h late
on that plan; the documented workaround (external pinger hitting the same
authenticated endpoint every 5–10 minutes) closes that gap without a code
change.

**LLM resilience.** Every summary call returns a typed
`{ data, status, error }`, never a bare string — `status: 'FAILED'` with
`data: null` is a first-class, expected outcome that the UI renders as an
explicit "unavailable, review manually" state, not an error page or
fabricated text.
