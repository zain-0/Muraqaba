# Muraqaba API

Backend for Muraqaba, a maintenance ticketing system for bus fleets. Express 5, MongoDB (Mongoose 8), JWT auth.

## Roles and flow

| Role | What they do |
| --- | --- |
| serviceCreator | Creates vendor accounts, adds and edits buses, raises tickets, fills in parts and labour, sends buses to vendors and confirms them back, receives accepted invoices and forwards them, fills the daily km and status sheets |
| supervisor | Approves or returns tickets, declines additional jobs, accepts or rejects invoices, reads the month sheets and the weekly report, can also add buses and raise tickets |
| vendor | Self-registers or is added by a service creator. Sends estimates with quotation number and days, acknowledges, receives the bus, works on it, raises additional jobs, releases it and submits invoices with a file |
| purchaseManager | Makes GRNs in batches, downloads them as Excel, makes purchase invoices and LPOs, runs queries. Sees tickets from the invoice stage on |

Ticket lifecycle:

```
Repairs, tyres, batteries and other work, where the price has to be agreed:
sentToVendor ──estimate (vendor)──▶ estimateSubmitted ──reply (creator)──▶ estimateCountered ──estimate (vendor)──▶ estimateSubmitted
                                            └──parts and labour, then escalate (creator)──▶ pending

Oil and transmission, when the bus has a rate and the VSR uses the bus's vendor: raised straight
into pending, priced at rate per km × the bus's interval. intervalUsage keeps how much was left or delayed.

Then, for both:
pending ──approve (supervisor)──▶ approved ──acknowledge (vendor)──▶ acknowledged
pending ──return (supervisor, reason required)──▶ returned ──correct, reply or escalate (creator)
acknowledged ──(creator)──▶ vehicleSent ──km (vendor)──▶ vehicleReceived ──▶ workInProgress ──▶ readyForDelivery ──▶ vehicleReleased
vehicleReleased ──km, replaced parts (creator)──▶ vehicleReturned ──invoice with file (vendor)──▶ invoiceSubmitted
invoiceSubmitted ──accept (supervisor)──▶ invoiceAccepted ──(creator)──▶ invoiceReceived ──(creator)──▶ forwardedToPurchase
invoiceSubmitted ──reject (supervisor)──▶ invoiceRejected ──resubmit (vendor)──▶ invoiceSubmitted
forwardedToPurchase ──GRN, in a batch (purchasing)──▶ grnCreated ──purchase invoice (purchasing)──▶ completed

Additional job, raised by the vendor while the bus is at the workshop, numbered after its parent (VSR-0012b):
estimateSubmitted ──same negotiation──▶ pending ──approve──▶ vehicleReceived, or ──decline──▶ declined
Releasing or getting back the bus moves every linked ticket. Invoice, GRN and purchase invoice stay separate.
```

The depot's dates default to now and can be overridden, never into the future. Accepting an invoice takes quantity and amount off the vendor's current LPO for tyres and batteries, and amount only for repairs, for oil and transmission services (a maintenance line, usually on their own LPO) and for other work. A short or missing LPO notifies purchasing and the supervisor and never blocks the invoice.

Drawn signatures are saved once per person and stamped on escalate, approve, acknowledge, release, invoice accept, GRN and purchase invoice. A stamp keeps the drawing it was made with.

Documents are stored in `uploads/` (or `UPLOAD_DIR`), outside git, and served only through the API to people who can see the ticket. GRN and purchase invoice files stay with the depot.

Vendors never receive: `breakdown`, `isBreakdown`, `intervalUsage`, `returnReason`, `lpoDeduction`, `grn`, `purchaseInvoice`, bus rates and intervals.

Month sheets, on UAE time (`/api/sheets`): daily km readings, daily bus status with a day-wise summary, and a repair process list with a day-wise summary. Service creators edit, supervisors read. A status holds until it is next changed; raising a ticket picks it unless the bus is in scrapping or removed.

Every transition is recorded in the ticket's `history`.

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

The tests are end-to-end: they walk the full lifecycle for every role, including the authorization boundaries between roles, against a real MongoDB. `npm test` starts the API itself on an ephemeral port using a separate `<database>_test` database and drops it afterwards, so it only needs MongoDB to be reachable. Quotation scanning runs against a local stand-in for Claude's URL, so no key or network is needed.

```bash
npm test                 # every file in tests/
npm test -- workshop     # only the files with this word in their name
```

## API

Interactive docs: `http://localhost:5000/api-docs` (regenerate with `npm run docs:generate`).

All responses are JSON with `success`. Errors carry a stable `code` (`VALIDATION_ERROR`, `NO_TOKEN`, `TOKEN_EXPIRED`, `FORBIDDEN`, `NOT_FOUND`, `DUPLICATE`, `INVALID_STATE` (someone moved it first), `NOT_READY` (something still has to be done first), `SIGNATURE_REQUIRED`, `SCAN_NOT_CONFIGURED`, `SCAN_FAILED`, `RATE_LIMITED`) and a `message` safe to show to users. Lists return `{ data, count, total, page, pages }` and accept `?page=&limit=&sort=newest|oldest`.

| Method | Path | Roles | Purpose |
| --- | --- | --- | --- |
| GET | /api/health | public | Liveness + DB status |
| POST | /api/auth/register | public | Create account. Development allows every role; production is off by default and limited to `SELF_REGISTER_ROLES` when enabled |
| GET | /api/auth/config | public | Whether self registration is open, and for which roles |
| POST | /api/auth/login | public | Get a JWT |
| GET | /api/auth/me | any | Current user |
| GET | /api/users/dashboard | any | Role-specific counters and `actionRequired` |
| GET, PUT | /api/users/signature | any | Your own signature, as a PNG data URL |
| GET | /api/vendors | creator, supervisor | Vendor directory with bus counts |
| POST | /api/vendors | creator | Create vendor account |
| GET | /api/buses | creator, supervisor, purchasing | Fleet, with `intervalStatus` |
| POST | /api/buses | creator, supervisor | Add a bus |
| GET | /api/buses/:id | creator, supervisor, purchasing | Details with `openTickets` |
| PUT | /api/buses/:id | creator | Edit a bus. New tickets use the changes; the vendor stays |
| GET | /api/tickets | any | Role-scoped list, `?status=&busId=&mine=&sort=oldest` |
| POST | /api/tickets | creator, supervisor | Raise ticket, with optional `isBreakdown` |
| GET | /api/tickets/:id | any | Detail with `history`, all `invoices`, `linkedTickets` and signature drawings |
| POST | /api/tickets/:id/estimate | vendor (owner) | Multipart: `amount`, `quotationNumber`, `daysToComplete`, `note`, `attachments` |
| POST | /api/tickets/:id/estimate/reply | creator, supervisor | Multipart: optional `amount`, `note`, `attachments` |
| PUT | /api/tickets/:id/breakdown | creator, supervisor | Parts, `labourHours`, `consumables`, `remarks` |
| POST | /api/tickets/:id/scan-quotation | creator, supervisor | Lines read from the quotation, to check. Saves nothing |
| PUT | /api/tickets/:id/escalate | creator, supervisor | Sends the latest estimate for approval, checks the breakdown covers it |
| PUT | /api/tickets/:id/approve | supervisor | pending → approved |
| PUT | /api/tickets/:id/return | supervisor | pending → returned (`reason`, hidden from vendors) |
| PUT | /api/tickets/:id/decline | supervisor | Additional job only: pending → declined (`reason`) |
| PUT | /api/tickets/:id/details | creator, supervisor | Correct a returned ticket |
| GET | /api/tickets/:id/attachments/:attachmentId | anyone who can see the ticket | Download a document |
| PUT | /api/tickets/:id/acknowledge | vendor (owner) | approved → acknowledged; `daysToComplete` when it has an agreed price |
| POST | /api/tickets/:id/additional | vendor (owner) | Multipart: additional job with its first estimate |
| PUT | /api/tickets/:id/vehicle/sent | creator, supervisor | acknowledged → vehicleSent |
| PUT | /api/tickets/:id/vehicle/received | vendor (owner) | vehicleSent → vehicleReceived (`km`) |
| PUT | /api/tickets/:id/work/start | vendor (owner) | vehicleReceived → workInProgress |
| PUT | /api/tickets/:id/work/ready | vendor (owner) | workInProgress → readyForDelivery |
| PUT | /api/tickets/:id/vehicle/release | vendor (owner) | readyForDelivery → vehicleReleased, with linked tickets |
| PUT | /api/tickets/:id/vehicle/returned | creator, supervisor | vehicleReleased → vehicleReturned (`km`, `replacedPartsReceived`), with linked tickets |
| POST | /api/tickets/:id/invoice | vendor (owner) | Multipart with a file: vehicleReturned or invoiceRejected → invoiceSubmitted |
| PUT | /api/tickets/:id/invoice/accept | supervisor | invoiceSubmitted → invoiceAccepted, takes it off the LPO |
| PUT | /api/tickets/:id/invoice/reject | supervisor | invoiceSubmitted → invoiceRejected (`reason`) |
| PUT | /api/tickets/:id/invoice/received | creator, supervisor | invoiceAccepted → invoiceReceived |
| PUT | /api/tickets/:id/forward | creator, supervisor | invoiceReceived → forwardedToPurchase |
| GET | /api/grns | purchasing, supervisor, creator | List GRNs |
| GET | /api/grns/export | purchasing | `?ticketIds=a,b` as an Excel file |
| POST | /api/grns | purchasing | Multipart: `number`, `ticketIds`, `date`, `notes`, `attachments` |
| POST | /api/purchase-invoices | purchasing | Multipart: `number`, `grnId`, `date`, `amount`, `notes`, `attachments`; closes the VSRs |
| GET | /api/lpos, /api/lpos/:id | purchasing, supervisor, creator | LPOs; one LPO also lists the VSRs that used it |
| POST | /api/lpos | purchasing | Create an LPO |
| GET | /api/reports/query | purchasing | `?brand=&type=&year=&vendorId=&busId=&isBreakdown=&groupBy=` |
| GET | /api/reports/fleet | creator, supervisor, purchasing | Month figures, `?year=&brand=` |
| GET | /api/reports/weekly | supervisor | Last seven days and what is due |
| GET | /api/notifications | any | Your own, with `unread`. Runs the alert checks at most every few minutes |
| PUT | /api/notifications/:id/read, /api/notifications/read-all | any | Mark read |
| GET, PUT | /api/sheets/readings | read: creator, supervisor; write: creator | Daily km (`?month=YYYY-MM`) |
| GET, PUT | /api/sheets/status | read: creator, supervisor; write: creator | Daily status (`?month=YYYY-MM`) |
| GET | /api/sheets/repairs | creator, supervisor | Repair process (`?month=YYYY-MM`) |

## Adding email

Alerts and the weekly report are in the app for now. Every notice passes through `notifyRoles` in `utils/notifications.js`, and every account has an email address, so email is one addition in one place:

1. Add a mail library and SMTP settings to `.env`.
2. In `notifyRoles`, send when `updateOne` reports `upsertedCount: 1`, so each person gets each notice once. Keep sending outside the write, so a mail failure cannot lose the notice.
3. Word the email from `type` and `params`. Screens do this in `lib/notifications.ts` in the frontend; the API has no wording of its own yet.
4. Call `runChecks()` from a timer. Checks only run today when someone reads their notifications, which is enough for the app but not for email, where a person may not have opened it at all. The weekly report's figures come from the same code as `GET /api/reports/weekly`.

## Production notes

- Set `NODE_ENV=production`, a 32+ character `JWT_SECRET` and `FRONTEND_URL` to the deployed UI origin. Self registration is off in production by default; if enabled with `ALLOW_PUBLIC_REGISTRATION=true`, only roles in `SELF_REGISTER_ROLES` (default `vendor`) can register. Set `TRUST_PROXY` only behind a reverse proxy.
- The compose MongoDB has no authentication and is bound to localhost. For a real deployment use a managed cluster or add `MONGO_INITDB_ROOT_USERNAME/PASSWORD` and credentials in `MONGO_URI`.
- `docker compose --profile full up -d` builds and runs the API next to MongoDB; `Dockerfile` runs as a non-root user with a health check.
- Rate limits: 300 requests / 15 min per IP overall and 20 / 15 min on login and register (override with `RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_MAX`).
- Quotation scanning needs `ANTHROPIC_API_KEY`. Files are sent to Anthropic and the model defaults to `claude-opus-5-5` (`QUOTATION_SCAN_MODEL` changes it). Without a key the endpoint answers 503 `SCAN_NOT_CONFIGURED`.
- Tickets and invoices use optimistic concurrency: when two people act on the same record at once, one succeeds and the other gets `409 INVALID_STATE`. MongoDB has no transactions on a standalone server, so paired writes are ordered so that a losing request leaves nothing behind.
