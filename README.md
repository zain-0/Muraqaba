# Muraqaba API

Backend for Muraqaba, a maintenance ticketing system for bus fleets. Express 5, MongoDB (Mongoose 8), JWT auth.

## Roles and flow

| Role | What they do |
| --- | --- |
| serviceCreator | Creates vendor accounts, adds buses (each assigned to a vendor), raises maintenance tickets, reviews vendor repair requests |
| supervisor | Approves tickets, accepts or rejects invoices, can also add buses and raise tickets |
| vendor | Acknowledges approved tickets for their buses, submits invoices, closes completed tickets, raises repair requests |
| purchaseManager | Read-only view of invoiced and completed tickets and totals |

Ticket lifecycle:

```
pending ──cancel (supervisor or creator)──▶ cancelled
pending ──approve (supervisor)──▶ approved ──acknowledge (vendor)──▶ acknowledged
   ──submit invoice (vendor)──▶ invoiceSubmitted ──accept (supervisor)──▶ invoiceAccepted ──complete (vendor)──▶ completed
                                        └──reject (supervisor)──▶ invoiceRejected ──resubmit (vendor)──▶ invoiceSubmitted
```

Vendors can only see and act on tickets and buses assigned to them. Every transition is recorded in the ticket's `history`.

## Run locally

Requirements: Node 20+, Docker (for MongoDB).

```bash
cp .env.example .env            # then set JWT_SECRET
npm install
npm run db:up                   # starts MongoDB 7 in Docker (docker compose up -d mongo)
npm run seed                    # demo accounts + fleet + tickets at every stage
npm run dev                     # http://localhost:5000, docs at /api-docs
```

Demo accounts created by the seed (password `Password123!` unless `SEED_PASSWORD` is set):

| Role | Email |
| --- | --- |
| serviceCreator | creator@muraqaba.dev |
| supervisor | supervisor@muraqaba.dev |
| purchaseManager | purchasing@muraqaba.dev |
| vendor | vendor@muraqaba.dev |
| vendor | vendor2@muraqaba.dev |

`npm run seed:reset` wipes the database and recreates the demo data.

No Docker? `npm run db:local` runs the official MongoDB binary (downloaded once by mongodb-memory-server) on port 27017 with data kept in `.data/mongo`. It is for development only; use Docker Compose or a managed cluster everywhere else.

## Tests

The tests are end-to-end: they walk the full lifecycle for every role, including the authorization boundaries between roles, against a real MongoDB. `npm test` starts the API itself on an ephemeral port using a separate `<database>_test` database and drops it afterwards, so it only needs MongoDB to be reachable.

```bash
npm test                                          # self-contained
API_URL=http://localhost:5000 node --test tests/api.test.js   # or against a server you started
```

## API

Interactive docs: `http://localhost:5000/api-docs` (regenerate with `npm run docs:generate`).

All responses are JSON with `success`. Errors carry a stable `code` (`VALIDATION_ERROR`, `NO_TOKEN`, `TOKEN_EXPIRED`, `FORBIDDEN`, `NOT_FOUND`, `DUPLICATE`, `INVALID_STATE`, `RATE_LIMITED`) and a `message` safe to show to users. Lists return `{ data, count, total, page, pages }` and accept `?page=&limit=&sort=newest|oldest`.

| Method | Path | Roles | Purpose |
| --- | --- | --- | --- |
| GET | /api/health | public | Liveness + DB status |
| POST | /api/auth/register | public | Create account. Development allows every role; production is off by default and limited to `SELF_REGISTER_ROLES` when enabled |
| GET | /api/auth/config | public | Whether self registration is open, and for which roles |
| POST | /api/auth/login | public | Get a JWT |
| GET | /api/auth/me | any | Current user |
| GET | /api/users/dashboard | any | Role-specific counters and `actionRequired` |
| GET | /api/vendors | creator, supervisor, purchasing | Vendor directory with bus counts |
| POST | /api/vendors | creator | Create vendor account |
| GET | /api/buses | any | Fleet (vendors: own buses only) |
| POST | /api/buses | creator, supervisor | Add a bus |
| GET/PUT | /api/buses/:id | any / creator, supervisor | Details (with `partsDue`, `openTickets`) / update readings or vendor |
| GET | /api/tickets | any | Role-scoped list, `?status=&busId=&mine=&sort=oldest` |
| POST | /api/tickets | creator, supervisor | Raise ticket (`repairRequestId` optional) |
| GET | /api/tickets/:id | any | Detail with `history` and all `invoices` |
| PUT | /api/tickets/:id/approve | supervisor | pending → approved |
| PUT | /api/tickets/:id/cancel | supervisor, or whoever raised it | pending → cancelled (`reason` required) |
| PUT | /api/tickets/:id/acknowledge | vendor (owner) | approved → acknowledged |
| POST | /api/tickets/:id/invoice | vendor (owner) | acknowledged or invoiceRejected → invoiceSubmitted |
| PUT | /api/tickets/:id/invoice/accept | supervisor | invoiceSubmitted → invoiceAccepted |
| PUT | /api/tickets/:id/invoice/reject | supervisor | invoiceSubmitted → invoiceRejected (`reason`) |
| PUT | /api/tickets/:id/complete | vendor (owner) | invoiceAccepted → completed |
| GET | /api/repair-requests | any | Role-scoped list, `?status=` |
| POST | /api/repair-requests | vendor | Flag a problem on an assigned bus |
| PUT | /api/repair-requests/:id/status | creator, supervisor | Resolve or reject (`note`) |

## Production notes

- Set `NODE_ENV=production`, a 32+ character `JWT_SECRET` and `FRONTEND_URL` to the deployed UI origin. Self registration is off in production by default; if enabled with `ALLOW_PUBLIC_REGISTRATION=true`, only roles in `SELF_REGISTER_ROLES` (default `vendor`) can register. Set `TRUST_PROXY` only behind a reverse proxy.
- The compose MongoDB has no authentication and is bound to localhost. For a real deployment use a managed cluster or add `MONGO_INITDB_ROOT_USERNAME/PASSWORD` and credentials in `MONGO_URI`.
- `docker compose --profile full up -d` builds and runs the API next to MongoDB; `Dockerfile` runs as a non-root user with a health check.
- Rate limits: 300 requests / 15 min per IP overall and 20 / 15 min on login and register (override with `RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_MAX`).
- Tickets, invoices and repair requests use optimistic concurrency: when two people act on the same record at once, one succeeds and the other gets `409 INVALID_STATE`. MongoDB has no transactions on a standalone server, so paired writes are ordered so that a losing request leaves nothing behind.
