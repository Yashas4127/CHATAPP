# CodeConnect deployment

## Architecture

Render runs one Node.js 22 Web Service from the repository root. Express serves the Vite build and the `/api` endpoints, while Socket.IO shares the same HTTPS origin. MongoDB Atlas stores application data; Judge0 runs submitted code outside the web service. Render manages the TLS certificate.

## Local development

1. Copy the relevant values from `.env.example` to `backend/.env`. Keep real environment files untracked. Use the existing `MESSAGE_ENCRYPTION_KEY` when migrating an existing database; changing it makes stored encrypted messages unreadable.
2. Keep `frontend/.env` set to `VITE_BACKEND_URL=http://localhost:5000` for Vite's API and WebSocket proxy.
3. Run `npm run install:all`, then `npm run dev`. The frontend runs on port 5713 and the backend on port 5000 unless `PORT` is set.
4. Run `npm run build` to generate `frontend/dist`; run `npm start` to serve the production build and API together.

## Render setup

Create a Blueprint deployment from the repository's `render.yaml` or create a Web Service with the same settings:

- Root directory: repository root
- Build: `npm ci && npm ci --prefix backend && npm ci --prefix frontend && npm run build`
- Start: `npm start`
- Health check: `/api/health`
- Runtime: Node.js 22

Set these secret environment variables in Render without committing them:

- `MONGODB_URI`: the existing MongoDB Atlas connection string; allow Render's outbound access in Atlas Network Access.
- `JWT_SECRET`: preserve the existing signing key.
- `MESSAGE_ENCRYPTION_KEY`: preserve the existing 64-character hexadecimal key.
- `ADMIN_USERNAME` and `ADMIN_PASSWORD`: set an administrator account; production requires a valid username and a password of at least 12 characters.

The Blueprint sets `NODE_ENV=production`, `COOKIE_SECURE=true`, and `TRUST_PROXY=true`. Render supplies `PORT`. `CLIENT_ORIGIN` is intentionally omitted: frontend, API, and Socket.IO share the same origin. `JUDGE0_API_URL` defaults to the public Judge0 CE endpoint; `JUDGE0_API_KEY` and `JUDGE0_API_HOST` are optional for a keyed Judge0 provider. Do not set `VITE_BACKEND_URL` in production.

## Smoke checks

- `GET /api/health` returns `200` with `{"status":"ok"}` only while MongoDB is connected; it returns `503` otherwise.
- Open the root page and a nested route directly; the Express SPA fallback should serve the app.
- Check browser network requests for same-origin `/api` and `/socket.io` traffic and verify cookies are `HttpOnly`, `Secure`, and `SameSite=Lax`.
- Use disposable test accounts and a non-production test database to test messaging, groups, collaboration, and code execution. Do not use shared production records for destructive tests.

## Rollback and redeployment

Redeploy a previously successful Render deployment from the service's Deploys page to roll back application code. Keep the existing MongoDB database and encryption key unchanged; code rollback does not roll back database data. Redeploy by pushing an approved commit to the connected branch or manually starting a deploy from the Render dashboard. If environment settings changed, restore the previous values before redeploying.
