# Counterline Job Card

A mobile-first PWA for carrying a sale from the shop floor to checkout. The app prepares the quote and handoff; the private billing system remains responsible for tax, official invoice creation, and accounting. Staff copy the handoff into that system and record its invoice reference and final total here.

## Current state

- React + TypeScript PWA shell with synthetic local demo data.
- FastAPI service and Supabase schema migration for the live path.
- Live data access is server-side through FastAPI. Keep the Supabase secret key out of frontend environment files.
- Staff invitations and manager role/access controls are implemented in the live path. Permission administration beyond built-in roles, realtime refresh, catalog editing, payment reversal, and production deployment remain outside this slice.

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

For staff invitations, set `FRONTEND_URL` on the backend to the deployed frontend origin. Add `<FRONTEND_URL>/auth/accept-invitation` to the Supabase Auth redirect URL allow-list and configure production email delivery. The invite link expiry in the app matches Supabase Auth's default one-hour email-link expiry; change both together if the project uses a different expiry.

After applying the staff invitation migration, managers can open **Team access**, invite employees, resend or cancel pending invitations, change staff roles, and suspend or reactivate store access. An employee receives active store membership only after opening the verified invite link, setting a password, and accepting it in the app. Manager accounts can manage salesperson, cashier, and promoter roles; only owner/admin accounts can assign manager roles. The Auth secret remains server-only.

## Supabase schema

The initial schema is in `supabase/migrations/20261110064135_initial_job_card_schema.sql`. After configuring Supabase CLI access for the project, link the local CLI and apply migrations with:

```powershell
npm run supabase -- login
npm run supabase -- link --project-ref uexamkpfpzzqzvghjymb
npm run supabase -- db push --remote --skip-vault --dry-run
npm run supabase -- db push --remote --skip-vault
```

Run the hosted migrations before starting the updated API. Supabase CLI v3 targets the local database by default. Review the dry-run output and confirm the hosted project when prompted. API routes validate store membership and permissions before using the server-side key.

## Build

```powershell
npm run build:web
```

Set `VITE_SUPPORT_PHONE` and `VITE_SUPPORT_EMAIL` before building to display your support contacts in the workspace footer. Leave either variable empty to hide its link.

Configure the frontend host to serve `index.html` for browser navigation to `/auth/accept-invitation` and unknown page paths. Counterline displays its missing-page screen for unknown paths. Configure the host’s fallback response with HTTP 404 for those paths if it supports route-specific status codes.

The PWA service worker caches the app shell and static assets only. API requests are never cached; full offline job entry and synchronization are out of scope for the first slice.

