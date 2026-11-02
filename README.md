# Muraqaba API

Backend for Muraqaba, a maintenance ticketing system for bus fleets. Express 5, MongoDB (Mongoose 8), JWT auth.

## Roles and flow

| Role | What they do |
| --- | --- |
| serviceCreator | Creates vendor accounts, adds buses (each assigned to a vendor), raises maintenance tickets, negotiates repair estimates and escalates them, sets vendor prices, fills the daily km and status sheets |
| supervisor | Approves or returns tickets, accepts or rejects invoices, reads the month sheets, can also add buses and raise tickets |
| vendor | Self-registers or is added by a service creator. Sends estimates with documents, acknowledges approved tickets, submits invoices, closes completed tickets |
| purchaseManager | Read-only view of invoiced and completed tickets and totals |

Ticket lifecycle:

```
Repairs and other work, where the price has to be agreed:
sentToVendor ──estimate (vendor)──▶ estimateSubmitted ──reply (creator)──▶ estimateCountered ──estimate (vendor)──▶ estimateSubmitted
                                            └──escalate (creator)──▶ pending

Minor and major services, when the vendor has a rate: raised straight into pending, priced at
rate per km × km since the bus's last ticket of that type (or its whole reading if it has none).

Then, for both:
pending ──approve (supervisor)──▶ approved ──acknowledge (vendor)──▶ acknowledged
pending ──return (supervisor, reason required)──▶ returned ──correct, reply or escalate (creator)
acknowledged ──submit invoice (vendor)──▶ invoiceSubmitted ──accept (supervisor)──▶ invoiceAccepted ──complete (vendor)──▶ completed
                                                  └──reject (supervisor)──▶ invoiceRejected ──resubmit (vendor)──▶ invoiceSubmitted
```

Estimate documents are stored in `uploads/` (or `UPLOAD_DIR`), outside git, and served only through the API to people who can see the ticket.

Month sheets, on UAE time (`/api/sheets`): daily km readings, daily bus status with a day-wise summary, and a repair process list with a day-wise summary. Service creators edit, supervisors read. A status holds until it is next changed; raising a ticket picks it unless the bus is in scrapping or removed.

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
| GET | /api/vendors | creator, supervisor | Vendor directory with bus counts |
| POST | /api/vendors | creator | Create vendor account |
| GET | /api/buses | creator, supervisor, purchasing | Fleet |
| POST | /api/buses | creator, supervisor | Add a bus |
| GET | /api/buses/:id | creator, supervisor, purchasing | Details with `openTickets` |
| GET | /api/tickets | any | Role-scoped list, `?status=&busId=&mine=&sort=oldest` |
| POST | /api/tickets | creator, supervisor | Raise ticket |
| GET | /api/tickets/:id | any | Detail with `history` and all `invoices` |
| POST | /api/tickets/:id/estimate | vendor (owner) | Multipart: `amount`, `note`, `attachments` |
| POST | /api/tickets/:id/estimate/reply | creator, supervisor | Multipart: optional `amount`, `note`, `attachments` |
| PUT | /api/tickets/:id/escalate | creator, supervisor | Sends the latest estimate for approval |
| PUT | /api/tickets/:id/return | supervisor | pending → returned (`reason`, hidden from vendors) |
| PUT | /api/tickets/:id/details | creator, supervisor | Correct a returned ticket |
| GET | /api/tickets/:id/attachments/:attachmentId | anyone who can see the ticket | Download a document |
| PUT | /api/vendors/:id/rates | creator | Agreed AED per km: `minor`, `major` |
| GET, PUT | /api/sheets/readings | read: creator, supervisor; write: creator | Daily km (`?month=YYYY-MM`) |
| GET, PUT | /api/sheets/status | read: creator, supervisor; write: creator | Daily status (`?month=YYYY-MM`) |
| GET | /api/sheets/repairs | creator, supervisor | Repair process (`?month=YYYY-MM`) |
| PUT | /api/tickets/:id/approve | supervisor | pending → approved |
| PUT | /api/tickets/:id/acknowledge | vendor (owner) | approved → acknowledged |
| POST | /api/tickets/:id/invoice | vendor (owner) | acknowledged or invoiceRejected → invoiceSubmitted |
| PUT | /api/tickets/:id/invoice/accept | supervisor | invoiceSubmitted → invoiceAccepted |
| PUT | /api/tickets/:id/invoice/reject | supervisor | invoiceSubmitted → invoiceRejected (`reason`) |
| PUT | /api/tickets/:id/complete | vendor (owner) | invoiceAccepted → completed |

## Production notes

- Set `NODE_ENV=production`, a 32+ character `JWT_SECRET` and `FRONTEND_URL` to the deployed UI origin. Self registration is off in production by default; if enabled with `ALLOW_PUBLIC_REGISTRATION=true`, only roles in `SELF_REGISTER_ROLES` (default `vendor`) can register. Set `TRUST_PROXY` only behind a reverse proxy.
- The compose MongoDB has no authentication and is bound to localhost. For a real deployment use a managed cluster or add `MONGO_INITDB_ROOT_USERNAME/PASSWORD` and credentials in `MONGO_URI`.
- `docker compose --profile full up -d` builds and runs the API next to MongoDB; `Dockerfile` runs as a non-root user with a health check.
- Rate limits: 300 requests / 15 min per IP overall and 20 / 15 min on login and register (override with `RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_MAX`).
- Tickets and invoices use optimistic concurrency: when two people act on the same record at once, one succeeds and the other gets `409 INVALID_STATE`. MongoDB has no transactions on a standalone server, so paired writes are ordered so that a losing request leaves nothing behind.
