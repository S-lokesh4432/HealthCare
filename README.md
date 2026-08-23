# Healthcare Appointment & Follow-up Manager

- `backend/` — Express + TypeScript API, Prisma/PostgreSQL, JWT auth, LLM/email/calendar integrations. See `backend/README.md` for setup, API reference, and the system design write-up.
- `frontend/` — Static site (BootstrapMade "Clinic" template) plus the portal pages (`login.html`, `register.html`, `book.html`, `dashboard-{patient,doctor,admin}.html`) wired to the backend API. No build step; serve it with any static file server and point `backend/.env`'s `CORS_ORIGIN` at that origin.

## Quick start

```bash
cd backend && npm install && cp .env.example .env   # fill in DATABASE_URL/DIRECT_URL/JWT_SECRET/CRON_SECRET at minimum
npx prisma migrate deploy && npx prisma db seed
npm run dev                     # http://localhost:4000

cd ../frontend && python3 -m http.server 5500   # http://localhost:5500/login.html
```

Demo accounts (password `Demo@1234`): `admin@demo.local`,
`dr.patel@demo.local` (Cardiology), `dr.khan@demo.local` (Dermatology),
`dr.reyes@demo.local` (Pediatrics).
