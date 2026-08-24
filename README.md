# Healthcare Appointment & Follow-up Manager

A full appointment booking and follow-up system for a clinic: patients book
verified-available slots, get an AI-assisted pre-visit intake summary,
doctors record visit notes and prescriptions, patients get an AI-generated
plain-language summary and medication reminders, and admins manage doctors,
leave days, and delivery failures.

Built as a real system, not a demo — every integration (LLM, email,
calendar) fails openly with a typed error state instead of faking success,
and the concurrency-critical paths are covered by tests that run against a
real Postgres instance.

## What's actually implemented

- **Auth** — register/login for patients, JWT (bcrypt-hashed passwords),
  role-based access (`PATIENT` / `DOCTOR` / `ADMIN`) enforced on every route
- **Booking** — search doctors, see real per-slot availability, place a
  7-minute hold, submit symptoms, confirm. Double-booking is prevented at
  the database level (a Postgres partial unique index), not just in
  application code — verified by firing 10 concurrent requests at the same
  slot and asserting exactly one wins
- **AI intake** — symptoms go to Gemini (xAI Grok fallback) for a
  structured urgency/chief-complaint/questions summary; if both providers
  fail, the UI shows an explicit "unavailable, review manually" state,
  never fabricated text
- **Visit notes & prescriptions** — doctors record notes and prescriptions;
  an AI patient-friendly summary is generated, and the doctor can edit it
  before it's sent
- **Medication reminders** — auto-scheduled per prescription
  (frequency × duration), delivered by a cron sweep
- **Notifications** — every email attempt is logged before sending;
  failures get retried with increasing backoff, then marked
  permanently-failed and surfaced to admins — never silently dropped,
  never retried forever
- **Leave handling** — marking a doctor on leave cancels their confirmed
  appointments for that day in one transaction and notifies every affected
  patient, reporting exact counts back to the admin
- **Calendar sync** — patients and doctors can independently connect Google
  Calendar; a booking creates events on whichever side is connected and
  skips silently (never blocks the booking) for the side that isn't
- **Security** — rate limiting on auth routes, security headers (helmet),
  AES-256-GCM-encrypted calendar tokens, timing-safe secret comparison,
  zero unused code (enforced by the TypeScript compiler), zero dependency
  vulnerabilities as of the last audit pass

## Stack

Express + TypeScript · PostgreSQL (Neon) via Prisma · custom JWT auth ·
Gemini/xAI for LLM summaries · Resend for email · Google Calendar API ·
vanilla HTML/JS frontend (Bootstrap, no build step) · Vercel serverless
hosting.

## Project layout

```
backend/     Express API — the whole system lives here
  src/
    routes/       auth, doctors, appointments, admin, calendar, cron
    services/     availability engine, booking/hold logic, llm/, email/, calendar/
    middleware/   JWT auth guard, role guard, rate limiting, validation
    lib/          time/date handling, JWT, encryption, typed errors
  prisma/        schema, migrations (incl. the double-booking index), seed script
  tests/         49+ tests against a real Postgres — concurrency, availability,
                 booking flow, leave races, notification retries, RBAC
  README.md      full setup guide, API reference, LLM prompts, Google Calendar
                 setup, and an ≤800-word system design write-up

frontend/    Static site — the BootstrapMade "Clinic" template, plus the
             portal pages (login, register, booking, three dashboards) wired
             to the backend's real REST API. No framework, no build step.
```

## Quick start

```bash
cd backend
npm install
cp .env.example .env        # fill in DATABASE_URL/DIRECT_URL/JWT_SECRET/CRON_SECRET at minimum
npx prisma migrate deploy && npx prisma db seed
npm run dev                 # http://localhost:4000

cd ../frontend
python3 -m http.server 5500 # http://localhost:5500/login.html
```

Demo accounts (password `Demo@1234`): `admin@demo.local`,
`dr.patel@demo.local` (Cardiology), `dr.khan@demo.local` (Dermatology),
`dr.reyes@demo.local` (Pediatrics).

Run the test suite (needs a real Postgres — the concurrency/race tests are
the ones worth reading):
```bash
cd backend && npm test
```

## Documentation

See **[`backend/README.md`](backend/README.md)** for the full setup guide,
complete API reference, exact LLM prompts, Google Calendar OAuth setup
steps, the Neon/serverless connection-pooling gotcha, and the system design
write-up covering double-booking prevention, the slot hold mechanism, leave
conflict handling, and notification failure handling in detail.

## Status

Core system: built, tested, verified end-to-end locally with live LLM
calls. Deployment (Vercel + Neon), live Google Calendar OAuth, and live
Resend email delivery are environment-dependent and tracked separately —
check the repo's recent commits for current status.
