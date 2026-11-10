# Counterline Job Card

A mobile-first PWA for carrying a sale from the shop floor to checkout. The app prepares the quote and handoff; the private billing system remains responsible for tax, official invoice creation, and accounting. Staff copy the handoff into that system and record its invoice reference and final total here.

## Current state

- React + TypeScript PWA shell with synthetic local demo data.
- FastAPI service and Supabase schema migration for the live path.
- Live data access is server-side through FastAPI. Keep the Supabase secret key out of frontend environment files.
- The Supabase project has not been provisioned from this workspace. The migration is local and has not been applied remotely.
- Staff invitations, permission administration, realtime refresh, catalog editing, payment reversal, and production deployment still need implementation.

## Run the local demo

Requirements: Node.js 20 or later. Python 3.12 or later is recommended for the API.

```powershell
npm install
npm run dev:web
```

Open the Vite URL printed by the command. In development, the app enters explicitly labeled demo mode and stores synthetic job changes in this browser's local storage. It does not connect to Supabase.

## Run the API

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn app.main:app --reload --port 8000
```

Fill in `backend/.env` with the project URL, publishable key, server-only secret key, and the email allowed to initialize the first store. Never commit `.env` or expose `SUPABASE_SECRET_KEY` to the browser.

For the live frontend, copy `frontend/.env.example` to `frontend/.env.local` and enter the project URL and publishable key. Keep `VITE_API_URL` pointed at the FastAPI service. Live sign-in uses Supabase Auth; the first authorized account creates the store workspace.

## Supabase schema

The initial schema is in `supabase/migrations/20261110064135_initial_job_card_schema.sql`. After configuring Supabase CLI access for the project, link the local CLI and apply migrations with:

```powershell
npm run supabase -- login
npm run supabase -- link --project-ref uexamkpfpzzqzvghjymb
npm run supabase -- db push
```

Review the migration and target project before applying it. Direct browser table access is revoked; API routes validate store membership and permissions before using the server-side key.

## Build

```powershell
npm run build:web
```

The PWA service worker caches the app shell and static assets only. API requests are never cached; full offline job entry and synchronization are out of scope for the first slice.

