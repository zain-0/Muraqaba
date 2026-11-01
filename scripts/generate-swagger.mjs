/**
 * Generates swagger/swagger.json (OpenAPI 3.0) from the route definitions below.
 * Run with: npm run docs:generate
 */
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ROLES = ['vendor', 'serviceCreator', 'supervisor', 'purchaseManager'];
const SERVICE_TYPES = ['minor', 'major', 'repair', 'other'];
const REPAIR_CATEGORIES = ['ELECTRICAL', 'MECHANICAL', 'AC REPAIR', 'ENGINE', 'BODY', 'BATTERY REPLACEMENT', 'TYRE REPLACEMENT'];
const TICKET_STATUSES = ['pending', 'approved', 'acknowledged', 'invoiceSubmitted', 'invoiceAccepted', 'invoiceRejected', 'completed'];

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
const part = {
  type: 'object',
  required: ['serviceKm', 'currentKm'],
  properties: {
    serviceKm: { type: 'number', description: 'Kilometres between services', example: 15000 },
    currentKm: { type: 'number', description: 'Kilometres since the last service of this part', example: 14200 },
  },
};
const busInput = {
  type: 'object',
  required: ['chassisNumber', 'fleetNumber', 'registrationNumber', 'make', 'model', 'year', 'vendorId', 'engine', 'ac', 'tyre', 'transmission', 'brakePad'],
  properties: {
    chassisNumber: { type: 'string' }, fleetNumber: { type: 'string' }, registrationNumber: { type: 'string' },
    make: { type: 'string' }, model: { type: 'string' }, year: { type: 'integer', example: 2021 },
    vendorId: { ...objectId, description: 'User id of the vendor responsible for this bus' },
    engine: part, ac: part, tyre: part, transmission: part, brakePad: part,
  },
};
const bus = {
  type: 'object',
  properties: {
    ...busInput.properties,
    _id: objectId,
    vendor: user,
    partsDue: { type: 'array', items: { type: 'string' }, description: 'Parts at or past their service interval' },
    createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
  },
};
const invoice = {
  type: 'object',
  properties: {
    _id: objectId, ticketId: objectId, vendorId: objectId, invoiceNumber: { type: 'string' },
    amount: { type: 'number' }, description: { type: 'string' },
    status: { type: 'string', enum: ['invoicePending', 'approved', 'rejected'] },
    submittedAt: { type: 'string', format: 'date-time' }, approvedAt: { type: 'string', format: 'date-time' },
    rejectedAt: { type: 'string', format: 'date-time' }, rejectionReason: { type: 'string' },
  },
};
const ticket = {
  type: 'object',
  properties: {
    _id: objectId, busId: bus, serviceType: { type: 'string', enum: SERVICE_TYPES },
    repairCategory: { type: 'string', enum: REPAIR_CATEGORIES }, description: { type: 'string' },
    vendorId: user, createdBy: user, status: { type: 'string', enum: TICKET_STATUSES },
    history: {
      type: 'array',
      items: { type: 'object', properties: { status: { type: 'string', enum: TICKET_STATUSES }, at: { type: 'string', format: 'date-time' }, by: user, note: { type: 'string' } } },
    },
    invoice: invoice, invoices: { type: 'array', items: invoice, description: 'All invoices ever submitted (detail endpoint only)' },
    initialApprovedBy: user, approvedAt: { type: 'string', format: 'date-time' },
    acknowledgedBy: user, acknowledgedAt: { type: 'string', format: 'date-time' },
    invoiceSubmittedAt: { type: 'string', format: 'date-time' }, invoiceApprovedBy: user, invoiceAcceptedAt: { type: 'string', format: 'date-time' },
    invoiceRejectedBy: user, invoiceRejectedAt: { type: 'string', format: 'date-time' }, completedAt: { type: 'string', format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
  },
};
const repairRequest = {
  type: 'object',
  properties: {
    _id: objectId, busId: bus, vendorId: user, description: { type: 'string' },
    repairCategory: { type: 'string', enum: REPAIR_CATEGORIES }, status: { type: 'string', enum: ['pending', 'resolved', 'rejected'] },
    resolvedBy: user, resolvedAt: { type: 'string', format: 'date-time' },
    rejectedBy: user, rejectedAt: { type: 'string', format: 'date-time' }, resolutionNote: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
  },
};
const authResponse = { type: 'object', properties: { success: { type: 'boolean' }, token: { type: 'string' }, user } };
const credentials = { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', minLength: 8 } } };

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
      '**Ticket lifecycle:** pending → approved (supervisor) → acknowledged (vendor) → invoiceSubmitted (vendor) → invoiceAccepted or invoiceRejected (supervisor) → completed (vendor). A rejected invoice goes back to the vendor for resubmission.',
      '',
      '**Roles:** serviceCreator manages vendors, buses and raises tickets; supervisor approves tickets and reviews invoices; vendor acknowledges, invoices and completes work on buses assigned to them and can raise repair requests; purchaseManager has read access to invoiced tickets.',
      '',
      'All list endpoints are scoped to what the caller may see. Errors always carry `success: false`, a stable `code` and a human readable `message`.',
    ].join('\n'),
  },
  servers: [{ url: 'http://localhost:5000', description: 'Local development' }],
  tags: [
    { name: 'Health' }, { name: 'Auth' }, { name: 'Users' }, { name: 'Vendors' }, { name: 'Buses' }, { name: 'Tickets' }, { name: 'Repair Requests' },
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
      User: user, Bus: bus, BusInput: busInput, Ticket: ticket, Invoice: invoice, RepairRequest: repairRequest,
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
    '/api/vendors/tickets': { get: op('Vendors', 'Tickets assigned to the signed-in vendor', ['vendor'], { query: ticketListQuery, response: listEnvelope(ref('Ticket')), more: pick(403) }) },
    '/api/buses': {
      get: op('Buses', 'List buses (vendors see only their own)', ROLES, { response: listEnvelope(ref('Bus')) }),
      post: op('Buses', 'Add a bus to the fleet', ['serviceCreator', 'supervisor'], { body: ref('BusInput'), response: envelope(ref('Bus')), status: 201, more: pick(400, 403, 404, 409) }),
    },
    '/api/buses/{id}': { get: op('Buses', 'Bus details with open ticket count', ['serviceCreator', 'supervisor', 'purchaseManager'], { params: [idParam], response: envelope(ref('Bus')), more: pick(400, 404) }) },
    '/api/tickets': {
      get: op('Tickets', 'List tickets visible to the caller', ROLES, { query: ticketListQuery, response: listEnvelope(ref('Ticket')), more: pick(400) }),
      post: op('Tickets', 'Raise a ticket (vendor is taken from the bus)', ['serviceCreator', 'supervisor'], {
        body: {
          type: 'object', required: ['busId', 'serviceType'],
          properties: {
            busId: objectId, serviceType: { type: 'string', enum: SERVICE_TYPES },
            repairCategory: { type: 'string', enum: REPAIR_CATEGORIES, description: 'Required when serviceType is repair' },
            description: { type: 'string', maxLength: 1000 },
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
    '/api/tickets/{id}/acknowledge': { put: op('Tickets', 'Vendor accepts an approved ticket', ['vendor'], { params: [idParam], response: envelope(ref('Ticket')), more: pick(403, 404, 409) }) },
    '/api/tickets/{id}/invoice': {
      post: op('Tickets', 'Vendor submits (or resubmits) an invoice', ['vendor'], {
        params: [idParam],
        body: { type: 'object', required: ['amount', 'description'], properties: { amount: { type: 'number', minimum: 0 }, description: { type: 'string' }, invoiceNumber: { type: 'string' } } },
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
    '/api/tickets/{id}/complete': { put: op('Tickets', 'Vendor closes the ticket after invoice acceptance', ['vendor'], { params: [idParam], response: envelope(ref('Ticket')), more: pick(403, 404, 409) }) },
    '/api/repair-requests': {
      post: op('Repair Requests', 'Vendor flags a problem on one of their buses', ['vendor'], {
        body: { type: 'object', required: ['busId', 'description', 'repairCategory'], properties: { busId: objectId, description: { type: 'string', minLength: 10 }, repairCategory: { type: 'string', enum: REPAIR_CATEGORIES } } },
        response: envelope(ref('RepairRequest')), status: 201, more: pick(400, 403, 404),
      }),
    },
    '/api/repair-requests/pending': { get: op('Repair Requests', 'Pending repair requests', ['serviceCreator', 'supervisor'], { query: pageQuery, response: listEnvelope(ref('RepairRequest')) }) },
    '/api/repair-requests/{id}/status': {
      put: op('Repair Requests', 'Resolve or reject a pending request', ['serviceCreator', 'supervisor'], {
        params: [idParam], body: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['resolved', 'rejected'] }, note: { type: 'string', maxLength: 500 } } },
        response: envelope(ref('RepairRequest')), more: pick(400, 403, 404, 409),
      }),
    },
  },
};

const out = join(__dirname, '..', 'swagger', 'swagger.json');
writeFileSync(out, JSON.stringify(spec, null, 2) + '\n');
console.log(`Wrote ${out} (${Object.keys(spec.paths).length} paths)`);
