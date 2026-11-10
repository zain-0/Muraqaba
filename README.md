# Muraqaba API

Backend for Muraqaba, a maintenance ticketing system for bus fleets. Express 5, MongoDB (Mongoose 8), JWT auth.

## Roles and flow

| Role | What they do |
| --- | --- |
| serviceCreator | Creates vendor accounts, adds and edits buses, raises tickets, fills in parts and labour, sends buses to vendors and confirms them back, receives accepted invoices and forwards them, fills the daily km and status sheets, raises scrap requests |
| supervisor | Approves or returns tickets, declines additional jobs, accepts or rejects invoices, approves or turns down scrap requests and records the sale of a scrapped bus, reads the month sheets and the weekly report, can also add buses and raise tickets |
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

The depot's dates default to now and can be overridden, never into the future.

LPOs (2026-11-10). Purchasing enters a dated LPO whose lines are Repair & Maintenance of one fleet make (one amount), a tyre size (quantity, unit price, optional life in km) or a battery type (quantity, unit price); the API names each line. Repairs, brake pads, oil and transmission come off the repair and maintenance line for the bus's make; tyres and batteries off a line of their kind, for any make.

- Raising or correcting a VSR: when any vendor's lines valid today fit the job, the creator picks one (`lpoItemId`) and its vendor does the work. Tyres and batteries then take a `quantity` and are priced at the line (`agreedPrice.basis: 'lpo'`), straight to the supervisor; repairs and brake pads take an `estimatedAmount`; oil and transmission the rate on the bus, or without one an `estimatedAmount`. With no line the VSR is raised as before and purchasing is notified (`lpoMissing`).
- What a VSR books on its line: the approved amount, else the agreed price, the creator's estimate or the vendor's latest estimate, and for tyres and batteries the units. Only open VSRs not yet on a GRN book anything. Raising or correcting past what is left (value − booked − GRN, the VSR's own booking left out) is refused; an approval or additional job that goes past it only notifies purchasing and the supervisor (`lpoProblem`).
- The GRN takes each VSR's accepted invoice (and units) off its line, in place of the booking. A VSR with no line gets the automatic choice: its vendor's lines valid today for the make and kind, ending first, the first with room. A short or missing LPO is notified and never blocks the GRN. VSRs charged at invoice acceptance before 2026-11-10 are not charged again.
- Tyres fitted off a line with a life in km set the bus's tyre interval to it.

Bus lifecycle: `inOperation` ──scrap request (creator; no open VSR)──▶ `scrapRequested` ──approve (supervisor)──▶ `scrapped` ──sale (supervisor)──▶ `sold`. Turning a request down or the creator cancelling it puts the bus back in operation. Only a bus in operation can have a VSR raised on it. A sold bus is archived: kept with all its history and never changed again. Reasons: `totalLoss`, `highRunningCost`, `endOfLife`.

Drawn signatures are saved once per person and stamped on escalate, approve, acknowledge, release, invoice accept, GRN and purchase invoice. A stamp keeps the drawing it was made with.

Documents are stored in `uploads/` (or `UPLOAD_DIR`), outside git, and served only through the API to people who can see the ticket. GRN and purchase invoice files stay with the depot.

Vendors never receive: `breakdown`, `isBreakdown`, `intervalUsage`, `returnReason`, `lpoLine`, `estimatedAmount`, `lpoDeduction`, `grn`, `purchaseInvoice`, bus rates and intervals. They do see `quantity` and `agreedPrice` on tyre and battery jobs, which are the job itself.

Month sheets, on UAE time (`/api/sheets`): daily km readings, daily bus status with a day-wise summary, and a repair process list with a day-wise summary. Service creators edit, supervisors read. A status holds until it is next changed; raising a ticket picks it. Scrapping and Removed are never set by hand: approving a scrap request writes Scrapping on the day (source `scrap`), and the sale writes Removed on the sale day. From a bus's `scrappedOn` the sheet refuses changes; days before can still be corrected. A bus already removed before a month (or year) and unchanged in it is left off that period's sheets and reports.

Databases from before 2026-11-09 are brought over by `scripts/migrate-fleet-lifecycle.js`, which sets each bus's lifecycle from its latest status and merges each LPO's repair and maintenance lines, taking the make most of the vendor's buses have. It can run any number of times; `--dry-run` writes nothing, and `--uri` (or `MONGO_URI`) chooses the database:

```bash
node scripts/migrate-fleet-lifecycle.js --dry-run --uri mongodb://localhost:27017/muraqaba_next
```

Then `scripts/migrate-lpo-items.js` brings LPOs and open VSRs into the 2026-11-10 shape: it dates each LPO by its first day, moves the LPO's make onto its repair and maintenance lines, names every line by the rule, and gives each open VSR with no line the one its GRN would take it off, so it is booked. Past deductions are left alone. The same `--dry-run` and `--uri`:

```bash
node scripts/migrate-lpo-items.js --dry-run --uri mongodb://localhost:27017/muraqaba_next
```

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
| GET | /api/users/dashboard | any | Role-specific counters and `actionRequired`; the supervisor's includes `scrapRequestsToDecide` |
| GET, PUT | /api/users/signature | any | Your own signature, as a PNG data URL |
| GET | /api/vendors | creator, supervisor | Vendor directory with bus counts |
| POST | /api/vendors | creator | Create vendor account |
| GET | /api/buses | creator, supervisor, purchasing | Fleet, with `intervalStatus`, `lifecycle`, `scrappedOn` and `sale`. Sold buses are included; screens hide them by default |
| POST | /api/buses | creator, supervisor | Add a bus |
| GET | /api/buses/:id | creator, supervisor, purchasing | Details with `openTickets` and `scrapRequests`, newest first |
| PUT | /api/buses/:id | creator | Edit a bus. New tickets use the changes; the vendor stays. A sold bus cannot be edited |
| PUT | /api/buses/:id/sale | supervisor | Multipart: `date` (on or after `scrappedOn`, not in the future), `buyer`, `price`, `note`, `attachments`. scrapped → sold |
| GET | /api/buses/:id/sale/attachments/:attachmentId | creator, supervisor, purchasing | Download a sale document |
| GET | /api/scrap-requests | creator, supervisor, purchasing | `?status=pending\|approved\|rejected\|cancelled&busId=`, paginated, with the bus and people populated |
| GET | /api/scrap-requests/:id | creator, supervisor, purchasing | One scrap request |
| POST | /api/scrap-requests | creator | Multipart: `busId`, `reason`, `note`, `attachments`. The bus must be in operation with no open VSR |
| PUT | /api/scrap-requests/:id/approve | supervisor | Optional `note`. Checks again for open VSRs; the bus is scrapped today |
| PUT | /api/scrap-requests/:id/reject | supervisor | `note` (the reason) required; the bus is back in operation |
| PUT | /api/scrap-requests/:id/cancel | creator who raised it | The bus is back in operation |
| GET | /api/scrap-requests/:id/attachments/:attachmentId | creator, supervisor, purchasing | Download a scrap request document |
| GET | /api/tickets | any | Role-scoped list, `?status=&busId=&mine=&sort=oldest` |
| POST | /api/tickets | creator, supervisor | Raise ticket, with optional `isBreakdown`. `lpoItemId` is required when lines fit the job; `quantity` for tyres and batteries off a line; `estimatedAmount` for repairs and brake pads off a line, and oil and transmission without a rate |
| GET | /api/tickets/:id | any | Detail with `history`, all `invoices`, `linkedTickets` and signature drawings |
| POST | /api/tickets/:id/estimate | vendor (owner) | Multipart: `amount`, `quotationNumber`, `daysToComplete`, `note`, `attachments` |
| POST | /api/tickets/:id/estimate/reply | creator, supervisor | Multipart: optional `amount`, `note`, `attachments` |
| PUT | /api/tickets/:id/breakdown | creator, supervisor | Parts, `labourHours`, `consumables`, `remarks` |
| POST | /api/tickets/:id/scan-quotation | creator, supervisor | Lines read from the quotation, to check. Saves nothing |
| PUT | /api/tickets/:id/escalate | creator, supervisor | Sends the latest estimate for approval, checks the breakdown covers it |
| PUT | /api/tickets/:id/approve | supervisor | pending → approved |
| PUT | /api/tickets/:id/return | supervisor | pending → returned (`reason`, hidden from vendors) |
| PUT | /api/tickets/:id/decline | supervisor | Additional job only: pending → declined (`reason`) |
| PUT | /api/tickets/:id/details, /api/tickets/:id | creator, supervisor | Correct a returned ticket, with the same fields as raising it |
| PUT | /api/tickets/:id/accident | creator, supervisor | Accident repairs only, any status: `severity` (minor, medium, major), `fault` (ourDriver, otherParty, unknown). Never shown to vendors |
| GET | /api/tickets/:id/attachments/:attachmentId | anyone who can see the ticket | Download a document |
| PUT | /api/tickets/:id/acknowledge | vendor (owner) | approved → acknowledged; `daysToComplete` when it has an agreed price |
| POST | /api/tickets/:id/additional | vendor (owner) | Multipart: additional job with its first estimate |
| PUT | /api/tickets/:id/vehicle/sent | creator, supervisor | acknowledged → vehicleSent |
| PUT | /api/tickets/:id/vehicle/received | vendor (owner) | vehicleSent → vehicleReceived (`km`) |
| PUT | /api/tickets/:id/work/start | vendor (owner) | vehicleReceived → workInProgress. At the depot: acknowledged → workInProgress (`km`) |
| PUT | /api/tickets/:id/work/ready | vendor (owner) | workInProgress → readyForDelivery |
| PUT | /api/tickets/:id/vehicle/release | vendor (owner) | readyForDelivery → vehicleReleased, with linked tickets |
| PUT | /api/tickets/:id/vehicle/returned | creator, supervisor | vehicleReleased → vehicleReturned (`km`, `replacedPartsReceived`), with linked tickets. At the depot it confirms the work is done: readyForDelivery → vehicleReturned. A no-charge VSR (approved at AED 0 with a reason) then closes with no invoice |
| POST | /api/tickets/:id/invoice | vendor (owner) | Multipart with a file: vehicleReturned or invoiceRejected → invoiceSubmitted |
| PUT | /api/tickets/:id/invoice/accept | supervisor | invoiceSubmitted → invoiceAccepted |
| PUT | /api/tickets/:id/invoice/reject | supervisor | invoiceSubmitted → invoiceRejected (`reason`) |
| PUT | /api/tickets/:id/invoice/received | creator, supervisor | invoiceAccepted → invoiceReceived |
| PUT | /api/tickets/:id/forward | creator, supervisor | invoiceReceived → forwardedToPurchase |
| GET | /api/grns | purchasing, supervisor, creator | List GRNs |
| GET | /api/grns/export | purchasing | `?ticketIds=a,b` as an Excel file |
| POST | /api/grns | purchasing | Multipart: `number`, `ticketIds`, `date`, `notes`, `attachments`. Takes each VSR off its LPO line |
| POST | /api/purchase-invoices | purchasing | Multipart: `number`, `grnId`, `date`, `amount`, `notes`, `attachments`; closes the VSRs |
| GET | /api/lpos | purchasing, supervisor, creator | LPOs with amount totals `value`, `booked`, `grn`, `available`, `afterGrn`, `vsrs` and `inDate` |
| GET | /api/lpos/:id | purchasing, supervisor, creator | One LPO; each line has its `balance` and its VSRs (`vsrs`: `_id`, `vsrNumber`, `fleetNumber`, `status`, `reserved`, `deducted`, `quantity`, `grnNumber`) |
| POST | /api/lpos | purchasing | Create an LPO: `number`, `vendorId`, `date`, `validFrom`, `validTo`, `items`. Each line: `kind` `repairMaintenance` (`make` on the fleet, the amount as `unitPrice`), `tyre` (`size`, `quantity`, `unitPrice`, optional `lifeKm`) or `battery` (`size`, `quantity`, `unitPrice`); optional `description` |
| GET | /api/lpos/items | purchasing, supervisor, creator | The LPO form's lists: fleet `makes`, `tyreSizes` and `batteryTypes` on LPOs |
| GET | /api/lpos/for-vsr | purchasing, supervisor, creator | `?busId=&serviceType=&ticketId=`: the lines the job can come off, each with its LPO, item and `balance` (`ticketId` leaves that VSR's own booking out); `status` `found`, `noLpo` or `notNeeded` |
| GET | /api/reports/query | purchasing | `?brand=&type=&year=&vendorId=&busId=&isBreakdown=&groupBy=` |
| GET | /api/reports/fleet | creator, supervisor, purchasing | Month figures, `?year=&brand=` |
| GET | /api/reports/weekly | supervisor | Last seven days and what is due |
| GET | /api/reports/lpo-balances | purchasing, supervisor, creator | `?vendorId=&kind=&inDate=true\|false`: each LPO line's value, booked, GRN, available and after-GRN figures with VSRs issued, per-LPO subtotals and a total |
| GET | /api/notifications | any | Your own, with `unread`. Runs the alert checks at most every few minutes |
| PUT | /api/notifications/:id/read, /api/notifications/read-all | any | Mark read |
| GET, PUT | /api/sheets/readings | read: creator, supervisor; write: creator | Daily km (`?month=YYYY-MM`) |
| GET, PUT | /api/sheets/status | read: creator, supervisor; write: creator | Daily status (`?month=YYYY-MM`) |
| GET | /api/sheets/repairs | creator, supervisor | Repair process (`?month=YYYY-MM`) |

## Adding email

Alerts and the weekly report are in the app for now. Every notice passes through `notifyUser` in `utils/notifications.js`, and every account has an email address, so email is one addition in one place:

1. Add a mail library and SMTP settings to `.env`.
2. In `notifyUser`, send when `updateOne` reports `upsertedCount: 1`, so each person gets each notice once. Keep sending outside the write, so a mail failure cannot lose the notice.
3. Word the email from `type` and `params`. Screens do this in `lib/notifications.ts` in the frontend; the API has no wording of its own yet.
4. Call `runChecks()` from a timer. Checks only run today when someone reads their notifications, which is enough for the app but not for email, where a person may not have opened it at all. The weekly report's figures come from the same code as `GET /api/reports/weekly`.

## Production notes

- Set `NODE_ENV=production`, a 32+ character `JWT_SECRET` and `FRONTEND_URL` to the deployed UI origin. Self registration is off in production by default; if enabled with `ALLOW_PUBLIC_REGISTRATION=true`, only roles in `SELF_REGISTER_ROLES` (default `vendor`) can register. Set `TRUST_PROXY` only behind a reverse proxy.
- The compose MongoDB has no authentication and is bound to localhost. For a real deployment use a managed cluster or add `MONGO_INITDB_ROOT_USERNAME/PASSWORD` and credentials in `MONGO_URI`.
- `docker compose --profile full up -d` builds and runs the API next to MongoDB; `Dockerfile` runs as a non-root user with a health check.
- Rate limits: 300 requests / 15 min per IP overall and 20 / 15 min on login and register (override with `RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_MAX`).
- Quotation scanning needs `ANTHROPIC_API_KEY`. Files are sent to Anthropic and the model defaults to `claude-opus-5-5` (`QUOTATION_SCAN_MODEL` changes it). Without a key the endpoint answers 503 `SCAN_NOT_CONFIGURED`.
- Tickets and invoices use optimistic concurrency: when two people act on the same record at once, one succeeds and the other gets `409 INVALID_STATE`. MongoDB has no transactions on a standalone server, so paired writes are ordered so that a losing request leaves nothing behind.
