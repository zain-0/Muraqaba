/**
 * Generates swagger/swagger.json (OpenAPI 3.0) from the route definitions below.
 * Run with: npm run docs:generate
 */
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ROLES = ['vendor', 'serviceCreator', 'supervisor', 'purchaseManager'];
const DEPOT = ['purchaseManager', 'supervisor', 'serviceCreator'];
const BUS_LIFECYCLES = ['inOperation', 'scrapRequested', 'scrapped', 'sold'];
const SCRAP_REASONS = ['totalLoss', 'highRunningCost', 'endOfLife'];
const SCRAP_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];
const LPO_KINDS = ['repairMaintenance', 'tyre', 'battery', 'other'];
const LPO_ITEM_CATEGORIES = ['repairMaintenance', 'tyre', 'battery'];
const SERVICE_TYPES = ['oil', 'transmission', 'tyre', 'battery', 'brakePads', 'repair', 'other'];
const REPAIR_CATEGORIES = ['ELECTRICAL', 'MECHANICAL', 'AC REPAIR', 'ENGINE', 'BODY', 'ACCIDENT'];
const TICKET_STATUSES = ['sentToVendor', 'estimateSubmitted', 'estimateCountered', 'pending', 'returned', 'approved', 'acknowledged', 'vehicleSent', 'vehicleReceived', 'workInProgress', 'readyForDelivery', 'vehicleReleased', 'vehicleReturned', 'invoiceSubmitted', 'invoiceAccepted', 'invoiceRejected', 'invoiceReceived', 'forwardedToPurchase', 'grnCreated', 'completed', 'declined'];

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const objectId = { type: 'string', example: '64b7f0c2e1d2a9b1c8a4f123' };
const idParam = { name: 'id', in: 'path', required: true, schema: objectId };
const json = (schema) => ({ 'application/json': { schema } });
const envelope = (dataSchema, extra = {}) => ({
  type: 'object',
  properties: { success: { type: 'boolean', example: true }, message: { type: 'string' }, data: dataSchema, ...extra },
});
const listEnvelope = (itemSchema) =>
  envelope(
    { type: 'array', items: itemSchema },
    { count: { type: 'integer' }, total: { type: 'integer' }, page: { type: 'integer' }, pages: { type: 'integer' } }
  );
const errors = {
  400: { description: 'Validation error', content: json(ref('Error')) },
  401: { description: 'Missing, invalid or expired token', content: json(ref('Error')) },
  403: { description: 'Role not allowed or resource owned by someone else', content: json(ref('Error')) },
  404: { description: 'Not found', content: json(ref('Error')) },
  409: { description: 'Duplicate or invalid state transition', content: json(ref('Error')) },
};
const pick = (...codes) => Object.fromEntries(codes.map((c) => [c, errors[c]]));
const op = (tag, summary, roles, { params = [], body, query = [], response, status = 200, more = {} } = {}) => ({
  tags: [tag],
  summary,
  description: roles ? `Roles: ${roles.join(', ')}` : 'Public',
  security: roles ? [{ bearerAuth: [] }] : [],
  parameters: [...params, ...query],
  ...(body ? { requestBody: { required: true, content: json(body) } } : {}),
  responses: { [status]: { description: 'OK', content: json(response) }, ...(roles ? pick(401) : {}), ...more },
});
const pageQuery = [
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
  { name: 'sort', in: 'query', schema: { type: 'string', enum: ['newest', 'oldest'], default: 'newest' }, description: 'Order by creation date' },
];

const user = {
  type: 'object',
  properties: { _id: objectId, name: { type: 'string' }, email: { type: 'string', format: 'email' }, role: { type: 'string', enum: ROLES } },
};
const kmInterval = {
  type: 'object',
  required: ['everyKm'],
  properties: {
    everyKm: { type: 'number', description: 'Kilometres between services', example: 10000 },
    lastKm: { type: 'number', description: 'Odometer at the last service', example: 0 },
  },
};
const busInput = {
  type: 'object',
  required: ['chassisNumber', 'fleetNumber', 'registrationNumber', 'make', 'model', 'year', 'registrationExpiry', 'expectedLifeYears', 'vendorId', 'intervals'],
  properties: {
    chassisNumber: { type: 'string' },
    fleetNumber: { type: 'string', description: 'Shown as the Side Number, painted on the bus' },
    registrationNumber: { type: 'string' },
    make: { type: 'string', description: 'Shown as the Brand' },
    model: { type: 'string', description: 'Shown as the Type' },
    year: { type: 'integer', description: 'Shown as the Model year', example: 2021 },
    registrationExpiry: { type: 'string', format: 'date' },
    expectedLifeYears: { type: 'integer', example: 15 },
    labourRate: { type: 'number', description: 'AED per repair labour hour' },
    rates: { type: 'object', description: 'AED per km, for the bus vendor', properties: { oil: { type: 'number' }, transmission: { type: 'number' } } },
    intervals: {
      type: 'object',
      required: ['oil', 'transmission', 'tyre', 'battery'],
      properties: {
        oil: kmInterval,
        transmission: kmInterval,
        tyre: kmInterval,
        battery: { type: 'object', required: ['everyMonths'], properties: { everyMonths: { type: 'integer', example: 18 }, lastDate: { type: 'string', format: 'date' } } },
      },
    },
    vendorId: { ...objectId, description: 'User id of the vendor responsible for this bus. Set when adding; locked afterwards.' },
  },
};
const attachment = { type: 'object', properties: { _id: objectId, name: { type: 'string' }, size: { type: 'integer' }, mimeType: { type: 'string' } } };
const day = { type: 'string', example: '2026-11-09', description: 'A UAE day, YYYY-MM-DD' };
const bus = {
  type: 'object',
  properties: {
    ...busInput.properties,
    _id: objectId,
    vendor: user,
    lifecycle: { type: 'string', enum: BUS_LIFECYCLES, description: 'Sold is archived: kept with its history, hidden from current lists, never changed again' },
    scrappedOn: { ...day, description: 'The day the scrap request was approved' },
    sale: {
      type: 'object',
      description: 'Recorded by the supervisor. A bus migrated from the daily sheet has a date only.',
      properties: { date: day, buyer: { type: 'string' }, price: { type: 'number', description: 'AED' }, note: { type: 'string' }, attachments: { type: 'array', items: attachment }, recordedBy: user, recordedAt: { type: 'string', format: 'date-time' } },
    },
    intervalStatus: { type: 'object', description: 'Where each interval stands, from the latest km reading', additionalProperties: true },
    openTickets: { type: 'integer', description: 'Detail endpoint only' },
    scrapRequests: { type: 'array', items: { $ref: '#/components/schemas/ScrapRequest' }, description: 'Detail endpoint only, newest first' },
    createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
  },
};
const scrapRequest = {
  type: 'object',
  properties: {
    _id: objectId,
    bus: { type: 'object', description: 'fleetNumber registrationNumber make model year lifecycle', additionalProperties: true },
    reason: { type: 'string', enum: SCRAP_REASONS },
    note: { type: 'string' },
    attachments: { type: 'array', items: attachment },
    status: { type: 'string', enum: SCRAP_REQUEST_STATUSES },
    createdBy: user, decidedBy: user, decidedAt: { type: 'string', format: 'date-time' },
    decisionNote: { type: 'string', description: 'The supervisor\'s note; the reason when turned down' },
    cancelledAt: { type: 'string', format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
  },
};
// One LPO line's figures, as on the client's sheet (2026-11-10). Quantities are null for repair and maintenance.
const figure = { type: 'object', properties: { amount: { type: 'number' }, quantity: { type: 'number', nullable: true } } };
const lpoBalance = {
  type: 'object',
  properties: {
    value: figure, booked: { ...figure, description: 'Open VSRs on the line not yet on a GRN' }, grn: { ...figure, description: 'What GRNs took off' },
    available: { ...figure, description: 'value - booked - grn: the limit for the next VSR' }, afterGrn: { ...figure, description: 'value - grn' },
    vsrs: { type: 'integer', description: 'VSRs on the line, every status but declined' },
  },
};
const lpoLines = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: LPO_KINDS },
    make: { type: 'string', description: 'The bus\'s make' },
    status: { type: 'string', enum: ['found', 'noLpo', 'notNeeded'], description: 'notNeeded: other work, which comes off no line' },
    lines: {
      type: 'array',
      description: 'The bus\'s own vendor\'s lines first, then the soonest ending, then by LPO number',
      items: {
        type: 'object',
        properties: {
          lpo: { type: 'object', properties: { _id: objectId, number: { type: 'string' }, date: { type: 'string', format: 'date-time' }, validTo: { type: 'string', format: 'date-time' }, vendor: { type: 'object', properties: { _id: objectId, name: { type: 'string' } } } } },
          item: { type: 'object', properties: { _id: objectId, name: { type: 'string' }, kind: { type: 'string', enum: LPO_KINDS }, make: { type: 'string', nullable: true }, size: { type: 'string', nullable: true }, lifeKm: { type: 'integer', nullable: true }, unitPrice: { type: 'number' } } },
          balance: ref('LpoBalance'),
        },
      },
    },
  },
};
const lpoItem = {
  type: 'object', required: ['kind'],
  properties: {
    kind: { type: 'string', enum: LPO_ITEM_CATEGORIES },
    make: { type: 'string', description: 'repairMaintenance only, required: a make on the fleet in any letter case, stored as the fleet spells it' },
    size: { type: 'string', description: 'The tyre size or battery type; required for those' },
    lifeKm: { type: 'integer', minimum: 1, description: 'Tyres only, optional. Fitting them sets the bus\'s tyre interval to it' },
    description: { type: 'string', maxLength: 300 },
    quantity: { type: 'integer', minimum: 1, description: 'Tyres and batteries; repair and maintenance is always 1' },
    unitPrice: { type: 'number', description: 'Above 0. For repair and maintenance, the amount' },
  },
};
const multipartNote = (fields) => `Multipart form: ${fields}. Files go in attachments (PDF, image, Word or Excel; up to 5, 10 MB each).`;
const invoice = {
  type: 'object',
  properties: {
    _id: objectId, ticketId: objectId, vendorId: objectId, invoiceNumber: { type: 'string' },
    amount: { type: 'number' }, description: { type: 'string' },
    attachments: { type: 'array', items: attachment },
    status: { type: 'string', enum: ['invoicePending', 'approved', 'rejected'] },
    submittedAt: { type: 'string', format: 'date-time' }, approvedAt: { type: 'string', format: 'date-time' },
    rejectedAt: { type: 'string', format: 'date-time' }, rejectionReason: { type: 'string' },
  },
};
const ticket = {
  type: 'object',
  properties: {
    _id: objectId, vsrNumber: { type: 'string', example: 'VSR-0012' },
    parentTicket: { ...objectId, description: 'Set on an additional job, numbered after its parent: VSR-0012b' },
    linkedTickets: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'The parent and additional jobs (detail endpoint only)' },
    busId: bus, serviceType: { type: 'string', enum: SERVICE_TYPES },
    repairCategory: { type: 'string', enum: REPAIR_CATEGORIES }, description: { type: 'string' },
    currentReading: { type: 'integer', minimum: 0, description: 'Odometer in km when the ticket was raised' },
    isBreakdown: { type: 'boolean', description: 'Broke down on the road. Never sent to vendors.' },
    daysToComplete: { type: 'integer', description: 'The vendor\'s latest promise' },
    agreedPrice: { type: 'object', description: 'Fixed at raising, so the VSR goes straight to the supervisor. rate: oil and transmission, the rate on the bus times its interval. lpo: tyres and batteries, the quantity times the LPO line\'s unit price', properties: { basis: { type: 'string', enum: ['rate', 'lpo'] }, rate: { type: 'number' }, km: { type: 'number' }, unitPrice: { type: 'number' }, quantity: { type: 'integer' }, amount: { type: 'number' } } },
    lpoLine: { type: 'object', description: 'The LPO line chosen at raising or correction; its amount is booked on it until the GRN. Never sent to vendors.', properties: { lpo: objectId, lpoNumber: { type: 'string' }, item: objectId, name: { type: 'string' }, kind: { type: 'string', enum: LPO_KINDS }, unitPrice: { type: 'number' } } },
    quantity: { type: 'integer', description: 'Tyres or batteries the job is for. Vendors see it on tyre and battery jobs only.' },
    estimatedAmount: { type: 'number', description: 'The creator\'s estimate, booked on the LPO line until approval. Never sent to vendors.' },
    intervalUsage: { type: 'object', description: 'How much of the interval was left or delayed. Never sent to vendors.', additionalProperties: true },
    breakdown: { type: 'object', description: 'Parts, labour and consumables checked against the estimate. Never sent to vendors.', additionalProperties: true },
    vehicle: { type: 'object', description: 'Dates and km of the bus going out and coming back', additionalProperties: true },
    signatures: { type: 'array', description: 'Who signed which step. The drawing is populated on the detail endpoint only.', items: { type: 'object', additionalProperties: true } },
    grn: { type: 'object', description: 'Never sent to vendors', additionalProperties: true },
    purchaseInvoice: { type: 'object', description: 'Never sent to vendors', additionalProperties: true },
    lpoDeduction: { type: 'object', description: 'What the GRN took off the LPO (before 2026-11-10, accepting the invoice). Never sent to vendors.', additionalProperties: true },
    approvedEstimate: { type: 'number' },
    vendorId: user, createdBy: user, status: { type: 'string', enum: TICKET_STATUSES },
    history: {
      type: 'array',
      items: { type: 'object', properties: { status: { type: 'string', enum: TICKET_STATUSES }, at: { type: 'string', format: 'date-time' }, effectiveAt: { type: 'string', format: 'date-time', description: 'The date the person gave' }, km: { type: 'number' }, by: user, note: { type: 'string' } } },
    },
    invoice: invoice, invoices: { type: 'array', items: invoice, description: 'All invoices ever submitted (detail endpoint only)' },
    initialApprovedBy: user, approvedAt: { type: 'string', format: 'date-time' },
    acknowledgedBy: user, acknowledgedAt: { type: 'string', format: 'date-time' },
    invoiceSubmittedAt: { type: 'string', format: 'date-time' }, invoiceApprovedBy: user, invoiceAcceptedAt: { type: 'string', format: 'date-time' },
    invoiceRejectedBy: user, invoiceRejectedAt: { type: 'string', format: 'date-time' }, completedAt: { type: 'string', format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
  },
};
const authResponse = { type: 'object', properties: { success: { type: 'boolean' }, token: { type: 'string' }, user } };
const credentials = { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', minLength: 8 } } };

// What raising or correcting a VSR takes for its LPO line (2026-11-10).
const vsrLpoFields = {
  lpoItemId: { ...objectId, description: 'The LPO line the job comes off; required when GET /api/lpos/for-vsr lists any. Its vendor does the work.' },
  quantity: { type: 'integer', minimum: 1, description: 'Tyres and batteries off a line: priced at its unit price, straight to the supervisor' },
  estimatedAmount: { type: 'number', description: 'Repairs and brake pads off a line, and oil and transmission off one without a rate on the bus' },
};
const stepBody = { type: 'object', properties: { date: { type: 'string', format: 'date', description: 'Defaults to now, cannot be in the future' } } };

const ticketListQuery = [
  { name: 'status', in: 'query', schema: { type: 'string', enum: TICKET_STATUSES } },
  { name: 'busId', in: 'query', schema: objectId },
  { name: 'mine', in: 'query', schema: { type: 'boolean' }, description: 'Only tickets created by the caller' },
  ...pageQuery,
];

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'Muraqaba Fleet Maintenance API',
    version: '1.1.0',
    description: [
      'Ticketing API for bus fleet maintenance with four roles.',
      '',
      '**Lifecycle:** sentToVendor → estimateSubmitted ⇄ estimateCountered → pending (with parts and labour filled in) → approved or returned → acknowledged → vehicleSent → vehicleReceived → workInProgress → readyForDelivery → vehicleReleased → vehicleReturned → invoiceSubmitted → invoiceAccepted or invoiceRejected → invoiceReceived → forwardedToPurchase → grnCreated → completed. Oil and transmission with a rate on the bus start at pending. Screens call a ticket a VSR.',
      '',
      '**Roles:** serviceCreator manages vendors and buses, raises tickets, fills in parts and labour, sends buses and forwards invoices; supervisor approves tickets and reviews invoices; vendor sends estimates, works on buses, releases them and invoices; purchaseManager makes GRNs, purchase invoices and LPOs and runs queries.',
      '',
      'All list endpoints are scoped to what the caller may see. Errors always carry `success: false`, a stable `code` and a human readable `message`.',
    ].join('\n'),
  },
  servers: [{ url: 'http://localhost:5000', description: 'Local development' }],
  tags: [
    { name: 'Health' }, { name: 'Auth' }, { name: 'Users' }, { name: 'Vendors' }, { name: 'Buses' }, { name: 'Scrapping' }, { name: 'Tickets' }, { name: 'Workshop' }, { name: 'Purchasing' }, { name: 'Reports' }, { name: 'Notifications' }, { name: 'Sheets' },
  ],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          code: { type: 'string', example: 'VALIDATION_ERROR' },
          message: { type: 'string' },
          errors: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, message: { type: 'string' } } } },
        },
      },
      User: user, Bus: bus, BusInput: busInput, Ticket: ticket, Invoice: invoice, ScrapRequest: scrapRequest, LpoLines: lpoLines, LpoBalance: lpoBalance,
    },
  },
  paths: {
    '/api/health': { get: op('Health', 'Liveness and database status', null, { response: { type: 'object', properties: { success: { type: 'boolean' }, status: { type: 'string' }, db: { type: 'string' }, uptime: { type: 'integer' } } } }) },
    '/api/auth/register': {
      post: op('Auth', 'Create an account (can be disabled with ALLOW_PUBLIC_REGISTRATION=false)', null, {
        body: { type: 'object', required: ['name', 'email', 'password', 'role'], properties: { name: { type: 'string' }, ...credentials.properties, role: { type: 'string', enum: ROLES } } },
        response: authResponse, status: 201, more: pick(400, 403, 409),
      }),
    },
    '/api/auth/config': {
      get: op('Auth', 'Whether self registration is open and for which roles', null, {
        response: envelope({ type: 'object', properties: { registration: { type: 'object', properties: { enabled: { type: 'boolean' }, roles: { type: 'array', items: { type: 'string', enum: ROLES } } } } } }),
      }),
    },
    '/api/auth/login': { post: op('Auth', 'Sign in and receive a JWT', null, { body: credentials, response: authResponse, more: pick(400, 401) }) },
    '/api/auth/me': { get: op('Auth', 'Current user', ROLES, { response: authResponse }) },
    '/api/users/profile': { get: op('Users', 'Current user profile', ROLES, { response: envelope(ref('User')) }) },
    '/api/users/dashboard': { get: op('Users', 'Role specific counters, including actionRequired. The supervisor\'s has scrapRequestsToDecide, counted in actionRequired.', ROLES, { response: envelope({ type: 'object', additionalProperties: true }) }) },
    '/api/vendors': {
      get: op('Vendors', 'List vendors with bus counts', ['serviceCreator', 'supervisor'], { response: listEnvelope(ref('User')), more: pick(403) }),
      post: op('Vendors', 'Create a vendor account', ['serviceCreator'], {
        body: { type: 'object', required: ['name', 'email', 'password'], properties: { name: { type: 'string' }, ...credentials.properties } },
        response: envelope(ref('User')), status: 201, more: pick(400, 403, 409),
      }),
    },
    '/api/sheets/readings': {
      get: op('Sheets', 'Daily km readings for every bus in a month', ['serviceCreator', 'supervisor'], { query: [{ name: 'month', in: 'query', schema: { type: 'string', example: '2026-11' } }], response: { type: 'object' }, more: pick(400, 403) }),
      put: op('Sheets', 'Save or clear one day of a bus (km: null clears it)', ['serviceCreator'], { body: { type: 'object', required: ['busId', 'date'], properties: { busId: objectId, date: { type: 'string' }, km: { type: 'integer', nullable: true } } }, response: { type: 'object' }, more: pick(400, 403, 404) }),
    },
    '/api/sheets/status': {
      get: op('Sheets', 'Daily status of every bus in a month, with a day-wise summary', ['serviceCreator', 'supervisor'], { query: [{ name: 'month', in: 'query', schema: { type: 'string', example: '2026-11' } }], response: { type: 'object' }, more: pick(400, 403) }),
      put: op('Sheets', 'Change a bus status from a day onward. Scrapping and removed are refused (they come from scrap requests), and so is any day from a scrapped or sold bus\'s scrappedOn (409).', ['serviceCreator'], { body: { type: 'object', required: ['busId', 'date', 'status'], properties: { busId: objectId, date: { type: 'string' }, status: { type: 'string', enum: ['ready', 'repair', 'maintenance', 'tyreChange', 'batteryChange', 'accident'] } } }, response: { type: 'object' }, more: pick(400, 403, 404, 409) }),
    },
    '/api/sheets/repairs': { get: op('Sheets', 'Repair process list with a day-wise summary', ['serviceCreator', 'supervisor'], { query: [{ name: 'month', in: 'query', schema: { type: 'string', example: '2026-11' } }], response: { type: 'object' }, more: pick(400, 403) }) },
    '/api/vendors/tickets': { get: op('Vendors', 'Tickets assigned to the signed-in vendor', ['vendor'], { query: ticketListQuery, response: listEnvelope(ref('Ticket')), more: pick(403) }) },
    '/api/buses': {
      get: op('Buses', 'List the fleet', ['serviceCreator', 'supervisor', 'purchaseManager'], { response: listEnvelope(ref('Bus')) }),
      post: op('Buses', 'Add a bus to the fleet', ['serviceCreator', 'supervisor'], { body: ref('BusInput'), response: envelope(ref('Bus')), status: 201, more: pick(400, 403, 404, 409) }),
    },
    '/api/buses/{id}': {
      get: op('Buses', 'Bus details with open ticket count and its scrap requests, newest first', ['serviceCreator', 'supervisor', 'purchaseManager'], { params: [idParam], response: envelope(ref('Bus')), more: pick(400, 404) }),
      put: op('Buses', 'Edit a bus. New tickets use the changes; the vendor stays as it was. A sold bus cannot be edited (409).', ['serviceCreator'], { params: [idParam], body: ref('BusInput'), response: envelope(ref('Bus')), more: pick(400, 403, 404, 409) }),
    },
    '/api/buses/{id}/sale': {
      put: {
        ...op('Scrapping', `Record the sale of a scrapped bus, which archives it. ${multipartNote('date (on or after scrappedOn, not in the future), buyer (up to 200 characters), price (AED, 0 or more, 2 decimals), note (up to 1000), attachments')} Writes Removed on the daily sheet from the sale day.`, ['supervisor'], { params: [idParam], response: envelope(ref('Bus')), more: pick(400, 403, 404, 409) }),
        requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['date', 'buyer', 'price'], properties: { date: day, buyer: { type: 'string' }, price: { type: 'number' }, note: { type: 'string' }, attachments: { type: 'array', items: { type: 'string', format: 'binary' } } } } } } },
      },
    },
    '/api/buses/{id}/sale/attachments/{attachmentId}': { get: op('Scrapping', 'Download a sale document', DEPOT, { params: [idParam, { name: 'attachmentId', in: 'path', required: true, schema: objectId }], response: { type: 'string', format: 'binary' }, more: pick(403, 404) }) },
    '/api/scrap-requests': {
      get: op('Scrapping', 'Scrap requests, newest first', DEPOT, { query: [{ name: 'status', in: 'query', schema: { type: 'string', enum: SCRAP_REQUEST_STATUSES } }, { name: 'busId', in: 'query', schema: objectId }, ...pageQuery], response: listEnvelope(ref('ScrapRequest')), more: pick(400, 403) }),
      post: {
        ...op('Scrapping', `Ask the supervisor to scrap a bus in operation with no open VSR. ${multipartNote('busId, reason, note (up to 1000), attachments')} Every supervisor is notified.`, ['serviceCreator'], { response: envelope(ref('ScrapRequest')), status: 201, more: pick(400, 403, 404, 409) }),
        requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['busId', 'reason'], properties: { busId: objectId, reason: { type: 'string', enum: SCRAP_REASONS }, note: { type: 'string' }, attachments: { type: 'array', items: { type: 'string', format: 'binary' } } } } } } },
      },
    },
    '/api/scrap-requests/{id}': { get: op('Scrapping', 'One scrap request', DEPOT, { params: [idParam], response: envelope(ref('ScrapRequest')), more: pick(400, 403, 404) }) },
    '/api/scrap-requests/{id}/approve': { put: op('Scrapping', 'Approve: checks again for open VSRs, scraps the bus today and writes Scrapping on the daily sheet. The creator is notified.', ['supervisor'], { params: [idParam], body: { type: 'object', properties: { note: { type: 'string', maxLength: 1000 } } }, response: envelope(ref('ScrapRequest')), more: pick(400, 403, 404, 409) }) },
    '/api/scrap-requests/{id}/reject': { put: op('Scrapping', 'Turn down, with the reason. The bus is back in operation and the creator is notified.', ['supervisor'], { params: [idParam], body: { type: 'object', required: ['note'], properties: { note: { type: 'string', maxLength: 1000 } } }, response: envelope(ref('ScrapRequest')), more: pick(400, 403, 404, 409) }) },
    '/api/scrap-requests/{id}/cancel': { put: op('Scrapping', 'Cancel a waiting request; only the creator who raised it. The bus is back in operation.', ['serviceCreator'], { params: [idParam], response: envelope(ref('ScrapRequest')), more: pick(403, 404, 409) }) },
    '/api/scrap-requests/{id}/attachments/{attachmentId}': { get: op('Scrapping', 'Download a scrap request document', DEPOT, { params: [idParam, { name: 'attachmentId', in: 'path', required: true, schema: objectId }], response: { type: 'string', format: 'binary' }, more: pick(403, 404) }) },
    '/api/tickets': {
      get: op('Tickets', 'List tickets visible to the caller', ROLES, { query: ticketListQuery, response: listEnvelope(ref('Ticket')), more: pick(400) }),
      post: op('Tickets', 'Raise a ticket (vendor defaults to the bus vendor)', ['serviceCreator', 'supervisor'], {
        body: {
          type: 'object', required: ['busId', 'serviceType', 'currentReading'],
          properties: {
            busId: objectId, serviceType: { type: 'string', enum: SERVICE_TYPES },
            repairCategory: { type: 'string', enum: REPAIR_CATEGORIES, description: 'Required when serviceType is repair' },
            currentReading: { type: 'integer', minimum: 0, description: 'Odometer in km' },
            vendorId: { ...objectId, description: 'Defaults to the vendor assigned to the bus' },
            description: { type: 'string', maxLength: 1000 },
            isBreakdown: { type: 'boolean', description: 'Broke down on the road. Never sent to vendors.' },
            ...vsrLpoFields,
          },
        },
        response: envelope(ref('Ticket')), status: 201, more: pick(400, 403, 404, 409),
      }),
    },
    '/api/tickets/pending': { get: op('Tickets', 'Tickets awaiting supervisor approval', ['serviceCreator', 'supervisor'], { query: pageQuery, response: listEnvelope(ref('Ticket')), more: pick(403) }) },
    '/api/tickets/my-tickets': { get: op('Tickets', 'Tickets created by the caller', ['serviceCreator', 'supervisor'], { query: pageQuery, response: listEnvelope(ref('Ticket')), more: pick(403) }) },
    '/api/tickets/completed': { get: op('Tickets', 'Completed tickets visible to the caller', ROLES, { query: pageQuery, response: listEnvelope(ref('Ticket')) }) },
    '/api/tickets/{id}': {
      get: op('Tickets', 'Ticket detail with full invoice history', ROLES, { params: [idParam], response: envelope(ref('Ticket')), more: pick(400, 404) }),
      put: op('Tickets', 'Correct the details of a returned ticket; the same as PUT /api/tickets/{id}/details', ['serviceCreator', 'supervisor'], { params: [idParam], response: envelope(ref('Ticket')), more: pick(400, 403, 404, 409) }),
    },
    '/api/tickets/{id}/approve': { put: op('Tickets', 'Approve a pending ticket', ['supervisor'], { params: [idParam], response: envelope(ref('Ticket')), more: pick(403, 404, 409) }) },
    '/api/tickets/{id}/return': { put: op('Tickets', 'Return a pending ticket to the creator', ['supervisor'], { params: [idParam], body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', maxLength: 500 } } }, response: envelope(ref('Ticket')), more: pick(400, 403, 404, 409) }) },
    '/api/tickets/{id}/details': { put: op('Tickets', 'Correct the details of a returned ticket, with the same fields as raising it. Checked against what its LPO line has left without its own booking.', ['serviceCreator', 'supervisor'], { params: [idParam], response: envelope(ref('Ticket')), more: pick(400, 403, 404, 409) }) },
    '/api/tickets/{id}/estimate': { post: op('Tickets', 'Vendor sends an estimate (multipart: amount, quotationNumber, daysToComplete, note, attachments)', ['vendor'], { params: [idParam], response: envelope(ref('Ticket')), status: 201, more: pick(400, 403, 404, 409) }) },
    '/api/tickets/{id}/estimate/reply': { post: op('Tickets', 'Creator replies to an estimate (multipart: amount, note, attachments)', ['serviceCreator', 'supervisor'], { params: [idParam], response: envelope(ref('Ticket')), status: 201, more: pick(400, 403, 404, 409) }) },
    '/api/tickets/{id}/escalate': { put: op('Tickets', 'Send the latest estimate to the supervisor', ['serviceCreator', 'supervisor'], { params: [idParam], response: envelope(ref('Ticket')), more: pick(403, 404, 409) }) },
    '/api/tickets/{id}/acknowledge': { put: op('Tickets', 'Vendor accepts an approved ticket. Gives daysToComplete when it has an agreed price.', ['vendor'], { params: [idParam], body: { type: 'object', properties: { daysToComplete: { type: 'integer', minimum: 1 } } }, response: envelope(ref('Ticket')), more: pick(400, 403, 404, 409) }) },
    '/api/tickets/{id}/breakdown': { put: op('Tickets', 'Save the parts, labour hours, consumables and remarks', ['serviceCreator', 'supervisor'], { params: [idParam], body: { type: 'object', properties: { parts: { type: 'array', items: { type: 'object', required: ['name', 'quantity', 'unitPrice'], properties: { name: { type: 'string' }, description: { type: 'string' }, code: { type: 'string' }, partNumber: { type: 'string' }, quantity: { type: 'number' }, unitPrice: { type: 'number' } } } }, labourHours: { type: 'number' }, consumables: { type: 'number' }, remarks: { type: 'string' } } }, response: envelope(ref('Ticket')), more: pick(400, 403, 404, 409) }) },
    '/api/tickets/{id}/scan-quotation': { post: op('Tickets', 'Read the vendor\'s quotation file with Claude and return lines to check. Saves nothing. 503 SCAN_NOT_CONFIGURED without ANTHROPIC_API_KEY.', ['serviceCreator', 'supervisor'], { params: [idParam], body: { type: 'object', properties: { attachmentId: objectId } }, response: envelope({ type: 'object', additionalProperties: true }), more: pick(400, 403, 404, 409) }) },
    '/api/tickets/{id}/decline': { put: op('Tickets', 'Decline an additional job waiting for approval', ['supervisor'], { params: [idParam], body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', maxLength: 500 } } }, response: envelope(ref('Ticket')), more: pick(400, 403, 404, 409) }) },
    '/api/tickets/{id}/additional': { post: op('Workshop', 'Raise an additional job while the bus is at the workshop (multipart: description, serviceType, repairCategory, amount, quotationNumber, daysToComplete, note, attachments)', ['vendor'], { params: [idParam], response: envelope(ref('Ticket')), status: 201, more: pick(400, 403, 404, 409) }) },
    '/api/tickets/{id}/vehicle/sent': { put: op('Workshop', 'The bus went to the vendor', ['serviceCreator', 'supervisor'], { params: [idParam], body: stepBody, response: envelope(ref('Ticket')), more: pick(400, 403, 404, 409) }) },
    '/api/tickets/{id}/vehicle/received': { put: op('Workshop', 'The vendor has the bus', ['vendor'], { params: [idParam], body: { type: 'object', required: ['km'], properties: { ...stepBody.properties, km: { type: 'integer' } } }, response: envelope(ref('Ticket')), more: pick(400, 403, 404, 409) }) },
    '/api/tickets/{id}/work/start': { put: op('Workshop', 'Work in progress', ['vendor'], { params: [idParam], body: stepBody, response: envelope(ref('Ticket')), more: pick(400, 403, 404, 409) }) },
    '/api/tickets/{id}/work/ready': { put: op('Workshop', 'Ready for delivery', ['vendor'], { params: [idParam], body: stepBody, response: envelope(ref('Ticket')), more: pick(400, 403, 404, 409) }) },
    '/api/tickets/{id}/vehicle/release': { put: op('Workshop', 'Release the bus, with every linked VSR at the workshop', ['vendor'], { params: [idParam], body: stepBody, response: envelope(ref('Ticket')), more: pick(400, 403, 404, 409) }) },
    '/api/tickets/{id}/vehicle/returned': { put: op('Workshop', 'The bus is back, for every linked VSR. Moves the last service on.', ['serviceCreator', 'supervisor'], { params: [idParam], body: { type: 'object', required: ['km'], properties: { ...stepBody.properties, km: { type: 'integer' }, replacedPartsReceived: { type: 'boolean' } } }, response: envelope(ref('Ticket')), more: pick(400, 403, 404, 409) }) },
    '/api/tickets/{id}/invoice/received': { put: op('Workshop', 'The creator has the accepted invoice', ['serviceCreator', 'supervisor'], { params: [idParam], body: stepBody, response: envelope(ref('Ticket')), more: pick(400, 403, 404, 409) }) },
    '/api/tickets/{id}/forward': { put: op('Workshop', 'Forward the invoice to purchasing', ['serviceCreator', 'supervisor'], { params: [idParam], body: stepBody, response: envelope(ref('Ticket')), more: pick(400, 403, 404, 409) }) },
    '/api/users/signature': {
      get: op('Users', 'Your own signature drawing', ROLES, { response: envelope({ type: 'object', properties: { image: { type: 'string', nullable: true } } }) }),
      put: op('Users', 'Save your signature as a PNG data URL', ROLES, { body: { type: 'object', required: ['image'], properties: { image: { type: 'string' } } }, response: envelope({ type: 'object', properties: { image: { type: 'string' } } }), more: pick(400) }),
    },
    '/api/grns': {
      get: op('Purchasing', 'List GRNs', ['purchaseManager', 'supervisor', 'serviceCreator'], { query: pageQuery, response: listEnvelope({ type: 'object', additionalProperties: true }), more: pick(403) }),
      post: op('Purchasing', 'Make one GRN for a batch of forwarded VSRs from one vendor (multipart: number, ticketIds, date, notes, attachments). Takes each VSR\'s accepted invoice off its LPO line.', ['purchaseManager'], { response: envelope({ type: 'object', additionalProperties: true }), status: 201, more: pick(400, 403, 404, 409) }),
    },
    '/api/grns/export': { get: op('Purchasing', 'The batch as an Excel file', ['purchaseManager'], { query: [{ name: 'ticketIds', in: 'query', required: true, schema: { type: 'string' }, description: 'Comma separated' }], response: { type: 'string', format: 'binary' }, more: pick(400, 403, 404) }) },
    '/api/purchase-invoices': { post: op('Purchasing', 'Make the purchase invoice of a GRN, which closes its VSRs (multipart: number, grnId, date, amount, notes, attachments)', ['purchaseManager'], { response: envelope({ type: 'object', additionalProperties: true }), status: 201, more: pick(400, 403, 404, 409) }) },
    '/api/lpos': {
      get: op('Purchasing', 'List LPOs, each with amount totals value, booked, grn, available, afterGrn, vsrs and inDate', ['purchaseManager', 'supervisor', 'serviceCreator'], { query: pageQuery, response: listEnvelope({ type: 'object', additionalProperties: true }), more: pick(403) }),
      post: op('Purchasing', 'Create an LPO. The API names each line: Repair & Maintenance of {make} Buses, Tyre size {size}, Battery {type}.', ['purchaseManager'], { body: { type: 'object', required: ['number', 'vendorId', 'date', 'validFrom', 'validTo', 'items'], properties: { number: { type: 'string' }, vendorId: objectId, date: { type: 'string', format: 'date' }, validFrom: { type: 'string', format: 'date' }, validTo: { type: 'string', format: 'date' }, items: { type: 'array', items: lpoItem } } }, response: envelope({ type: 'object', additionalProperties: true }), status: 201, more: pick(400, 403, 404, 409) }),
    },
    '/api/lpos/items': { get: op('Purchasing', 'The LPO form\'s lists: the fleet\'s makes, and the tyre sizes and battery types already on LPOs', DEPOT, { response: envelope({ type: 'object', properties: { makes: { type: 'array', items: { type: 'string' } }, tyreSizes: { type: 'array', items: { type: 'string' } }, batteryTypes: { type: 'array', items: { type: 'string' } } } }), more: pick(403) }) },
    '/api/lpos/for-vsr': {
      get: op('Purchasing', 'The LPO lines a job can be raised against, with what is left on each, for the new VSR and correction forms. Reads only.', DEPOT, {
        query: [
          { name: 'busId', in: 'query', required: true, schema: objectId },
          { name: 'serviceType', in: 'query', required: true, schema: { type: 'string', enum: SERVICE_TYPES } },
          { name: 'ticketId', in: 'query', schema: objectId, description: 'A VSR being corrected: its own booking is left out of what is left' },
        ],
        response: envelope(ref('LpoLines')), more: pick(400, 403, 404),
      }),
    },
    '/api/lpos/{id}': { get: op('Purchasing', 'One LPO; each line with its balance and its VSRs (vsrs: _id, vsrNumber, fleetNumber, status, reserved, deducted, quantity, grnNumber)', ['purchaseManager', 'supervisor', 'serviceCreator'], { params: [idParam], response: envelope({ type: 'object', additionalProperties: true }), more: pick(403, 404) }) },
    '/api/reports/lpo-balances': {
      get: op('Reports', 'Each LPO line\'s value, booked, GRN, available and after-GRN figures and VSRs issued, with per-LPO subtotals (amounts) and a total', DEPOT, {
        query: [
          { name: 'vendorId', in: 'query', schema: objectId },
          { name: 'kind', in: 'query', schema: { type: 'string', enum: LPO_KINDS } },
          { name: 'inDate', in: 'query', schema: { type: 'string', enum: ['true', 'false'] }, description: 'Valid today or not; left out, every LPO' },
        ],
        response: envelope({ type: 'object', properties: { today: { type: 'string', format: 'date' }, rows: { type: 'array', items: { type: 'object', additionalProperties: true } }, lpos: { type: 'array', items: { type: 'object', additionalProperties: true } }, total: { type: 'object', additionalProperties: true }, filters: { type: 'object', properties: { vendors: { type: 'array', items: { type: 'object', additionalProperties: true } }, kinds: { type: 'array', items: { type: 'string' } } } } } }),
        more: pick(400, 403),
      }),
    },
    '/api/reports/query': { get: op('Reports', 'How many of what, for which brand, vendor, bus or year', ['purchaseManager'], { query: ['brand', 'type', 'year', 'vendorId', 'busId', 'isBreakdown', 'groupBy'].map((name) => ({ name, in: 'query', schema: { type: 'string' } })), response: envelope({ type: 'object', additionalProperties: true }), more: pick(400, 403) }) },
    '/api/reports/fleet': { get: op('Reports', 'Month figures for repairs, tyres, batteries and maintenance, by brand or for the fleet', ['serviceCreator', 'supervisor', 'purchaseManager'], { query: ['year', 'brand'].map((name) => ({ name, in: 'query', schema: { type: 'string' } })), response: envelope({ type: 'object', additionalProperties: true }), more: pick(400, 403) }) },
    '/api/reports/weekly': { get: op('Reports', 'The last seven days of tyres, batteries and oil, and what is due', ['supervisor'], { response: envelope({ type: 'object', additionalProperties: true }), more: pick(403) }) },
    '/api/notifications': { get: op('Notifications', 'Your own notifications, newest first, with the unread count', ROLES, { response: { type: 'object', properties: { success: { type: 'boolean' }, unread: { type: 'integer' }, data: { type: 'array', items: { type: 'object', additionalProperties: true } } } } }) },
    '/api/notifications/read-all': { put: op('Notifications', 'Mark all of yours as read', ROLES, { response: { type: 'object', properties: { success: { type: 'boolean' } } } }) },
    '/api/notifications/{id}/read': { put: op('Notifications', 'Mark one of yours as read', ROLES, { params: [idParam], response: envelope({ type: 'object', additionalProperties: true }), more: pick(404) }) },
    '/api/tickets/{id}/invoice': {
      post: op('Tickets', 'Vendor submits (or resubmits) an invoice (multipart: amount, description, invoiceNumber, attachments; a file is required)', ['vendor'], {
        params: [idParam],
        response: envelope(ref('Ticket')), status: 201, more: pick(400, 403, 404, 409),
      }),
    },
    '/api/tickets/{id}/invoice/accept': { put: op('Tickets', 'Accept the submitted invoice', ['supervisor'], { params: [idParam], response: envelope(ref('Ticket')), more: pick(403, 404, 409) }) },
    '/api/tickets/{id}/invoice/reject': {
      put: op('Tickets', 'Reject the submitted invoice with an optional reason', ['supervisor'], {
        params: [idParam], body: { type: 'object', properties: { reason: { type: 'string', maxLength: 500 } } },
        response: envelope(ref('Ticket')), more: pick(400, 403, 404, 409),
      }),
    },
  },
};

const out = join(__dirname, '..', 'swagger', 'swagger.json');
writeFileSync(out, JSON.stringify(spec, null, 2) + '\n');
console.log(`Wrote ${out} (${Object.keys(spec.paths).length} paths)`);
