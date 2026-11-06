/**
 * Generates swagger/swagger.json (OpenAPI 3.0) from the route definitions below.
 * Run with: npm run docs:generate
 */
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ROLES = ['vendor', 'serviceCreator', 'supervisor', 'purchaseManager'];
const SERVICE_TYPES = ['oil', 'transmission', 'tyre', 'battery', 'repair', 'other'];
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
const bus = {
  type: 'object',
  properties: {
    ...busInput.properties,
    _id: objectId,
    vendor: user,
    intervalStatus: { type: 'object', description: 'Where each interval stands, from the latest km reading', additionalProperties: true },
    createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
  },
};
const attachment = { type: 'object', properties: { _id: objectId, name: { type: 'string' }, size: { type: 'integer' }, mimeType: { type: 'string' } } };
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
    agreedPrice: { type: 'object', description: 'Oil and transmission: rate on the bus times its interval, frozen at raising', properties: { rate: { type: 'number' }, km: { type: 'number' }, amount: { type: 'number' } } },
    intervalUsage: { type: 'object', description: 'How much of the interval was left or delayed. Never sent to vendors.', additionalProperties: true },
    breakdown: { type: 'object', description: 'Parts, labour and consumables checked against the estimate. Never sent to vendors.', additionalProperties: true },
    vehicle: { type: 'object', description: 'Dates and km of the bus going out and coming back', additionalProperties: true },
    signatures: { type: 'array', description: 'Who signed which step. The drawing is populated on the detail endpoint only.', items: { type: 'object', additionalProperties: true } },
    grn: { type: 'object', description: 'Never sent to vendors', additionalProperties: true },
    purchaseInvoice: { type: 'object', description: 'Never sent to vendors', additionalProperties: true },
    lpoDeduction: { type: 'object', description: 'What accepting the invoice took off the LPO. Never sent to vendors.', additionalProperties: true },
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
    { name: 'Health' }, { name: 'Auth' }, { name: 'Users' }, { name: 'Vendors' }, { name: 'Buses' }, { name: 'Tickets' }, { name: 'Workshop' }, { name: 'Purchasing' }, { name: 'Reports' }, { name: 'Notifications' }, { name: 'Sheets' },
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
      User: user, Bus: bus, BusInput: busInput, Ticket: ticket, Invoice: invoice,
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
    '/api/users/dashboard': { get: op('Users', 'Role specific counters, including actionRequired', ROLES, { response: envelope({ type: 'object', additionalProperties: true }) }) },
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
      put: op('Sheets', 'Change a bus status from a day onward', ['serviceCreator'], { body: { type: 'object', required: ['busId', 'date', 'status'], properties: { busId: objectId, date: { type: 'string' }, status: { type: 'string' } } }, response: { type: 'object' }, more: pick(400, 403, 404) }),
    },
    '/api/sheets/repairs': { get: op('Sheets', 'Repair process list with a day-wise summary', ['serviceCreator', 'supervisor'], { query: [{ name: 'month', in: 'query', schema: { type: 'string', example: '2026-11' } }], response: { type: 'object' }, more: pick(400, 403) }) },
    '/api/vendors/tickets': { get: op('Vendors', 'Tickets assigned to the signed-in vendor', ['vendor'], { query: ticketListQuery, response: listEnvelope(ref('Ticket')), more: pick(403) }) },
    '/api/buses': {
      get: op('Buses', 'List the fleet', ['serviceCreator', 'supervisor', 'purchaseManager'], { response: listEnvelope(ref('Bus')) }),
      post: op('Buses', 'Add a bus to the fleet', ['serviceCreator', 'supervisor'], { body: ref('BusInput'), response: envelope(ref('Bus')), status: 201, more: pick(400, 403, 404, 409) }),
    },
    '/api/buses/{id}': {
      get: op('Buses', 'Bus details with open ticket count', ['serviceCreator', 'supervisor', 'purchaseManager'], { params: [idParam], response: envelope(ref('Bus')), more: pick(400, 404) }),
      put: op('Buses', 'Edit a bus. New tickets use the changes; the vendor stays as it was.', ['serviceCreator'], { params: [idParam], body: ref('BusInput'), response: envelope(ref('Bus')), more: pick(400, 403, 404, 409) }),
    },
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
          },
        },
        response: envelope(ref('Ticket')), status: 201, more: pick(400, 403, 404, 409),
      }),
    },
    '/api/tickets/pending': { get: op('Tickets', 'Tickets awaiting supervisor approval', ['serviceCreator', 'supervisor'], { query: pageQuery, response: listEnvelope(ref('Ticket')), more: pick(403) }) },
    '/api/tickets/my-tickets': { get: op('Tickets', 'Tickets created by the caller', ['serviceCreator', 'supervisor'], { query: pageQuery, response: listEnvelope(ref('Ticket')), more: pick(403) }) },
    '/api/tickets/completed': { get: op('Tickets', 'Completed tickets visible to the caller', ROLES, { query: pageQuery, response: listEnvelope(ref('Ticket')) }) },
    '/api/tickets/{id}': { get: op('Tickets', 'Ticket detail with full invoice history', ROLES, { params: [idParam], response: envelope(ref('Ticket')), more: pick(400, 404) }) },
    '/api/tickets/{id}/approve': { put: op('Tickets', 'Approve a pending ticket', ['supervisor'], { params: [idParam], response: envelope(ref('Ticket')), more: pick(403, 404, 409) }) },
    '/api/tickets/{id}/return': { put: op('Tickets', 'Return a pending ticket to the creator', ['supervisor'], { params: [idParam], body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', maxLength: 500 } } }, response: envelope(ref('Ticket')), more: pick(400, 403, 404, 409) }) },
    '/api/tickets/{id}/details': { put: op('Tickets', 'Correct the details of a returned ticket', ['serviceCreator', 'supervisor'], { params: [idParam], response: envelope(ref('Ticket')), more: pick(400, 403, 404, 409) }) },
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
      post: op('Purchasing', 'Make one GRN for a batch of forwarded VSRs from one vendor (multipart: number, ticketIds, date, notes, attachments)', ['purchaseManager'], { response: envelope({ type: 'object', additionalProperties: true }), status: 201, more: pick(400, 403, 404, 409) }),
    },
    '/api/grns/export': { get: op('Purchasing', 'The batch as an Excel file', ['purchaseManager'], { query: [{ name: 'ticketIds', in: 'query', required: true, schema: { type: 'string' }, description: 'Comma separated' }], response: { type: 'string', format: 'binary' }, more: pick(400, 403, 404) }) },
    '/api/purchase-invoices': { post: op('Purchasing', 'Make the purchase invoice of a GRN, which closes its VSRs (multipart: number, grnId, date, amount, notes, attachments)', ['purchaseManager'], { response: envelope({ type: 'object', additionalProperties: true }), status: 201, more: pick(400, 403, 404, 409) }) },
    '/api/lpos': {
      get: op('Purchasing', 'List LPOs', ['purchaseManager', 'supervisor', 'serviceCreator'], { query: pageQuery, response: listEnvelope({ type: 'object', additionalProperties: true }), more: pick(403) }),
      post: op('Purchasing', 'Create an LPO', ['purchaseManager'], { body: { type: 'object', required: ['number', 'vendorId', 'validFrom', 'validTo', 'items'], properties: { number: { type: 'string' }, vendorId: objectId, validFrom: { type: 'string', format: 'date' }, validTo: { type: 'string', format: 'date' }, items: { type: 'array', items: { type: 'object', required: ['kind', 'name', 'quantity', 'unitPrice'], properties: { kind: { type: 'string', enum: ['tyre', 'battery', 'repair', 'other'] }, name: { type: 'string' }, description: { type: 'string' }, quantity: { type: 'number' }, unitPrice: { type: 'number' } } } } } }, response: envelope({ type: 'object', additionalProperties: true }), status: 201, more: pick(400, 403, 404, 409) }),
    },
    '/api/lpos/{id}': { get: op('Purchasing', 'One LPO with the VSRs that used it', ['purchaseManager', 'supervisor', 'serviceCreator'], { params: [idParam], response: envelope({ type: 'object', additionalProperties: true }), more: pick(403, 404) }) },
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
