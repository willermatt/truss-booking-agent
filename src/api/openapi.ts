/**
 * The booking API as an OpenAPI 3.1 document, for a ChatGPT custom GPT (Actions) or any other assistant
 * that can call an HTTP API. Printed by `npm run api -- openapi https://your-host`; it is not served.
 */
import { z } from 'zod';
import { BookingRequestSchema } from '../booking/schema.js';
import { loadCatalog } from '../booking/services.js';

export function openApiDocument(serverUrl: string) {
  const cat = loadCatalog();
  const services = cat.services.map((s) => `${s.label.trim()} (add-ons: ${s.addOns.map((a) => a.label).join(', ') || 'none'})`).join('; ');
  const request = z.toJSONSchema(BookingRequestSchema) as Record<string, unknown>;
  delete request.$schema;
  const key = { name: 'Idempotency-Key', in: 'header', required: true,
                description: 'A new unique value per booking, 8–180 characters [A-Za-z0-9._:-]. Reuse it only to check the same booking.',
                schema: { type: 'string', pattern: '^[A-Za-z0-9._:-]{8,180}$' } };
  return {
    openapi: '3.1.0',
    info: { title: 'Truss booking agent', version: '1.0.0',
            description: `Books Truss Home Inspections through Spectora's online scheduler. Services: ${services}. ` +
                         'A booking runs in the background: start it, then read its status with the same key. ' +
                         'REQUESTED means Spectora has the request; the owner confirms it in Spectora.' },
    servers: [{ url: serverUrl.replace(/\/+$/, '') }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      schemas: { BookingRequest: request },
    },
    security: [{ bearer: [] }],
    paths: {
      '/v1/bookings': {
        post: {
          operationId: 'startBooking',
          summary: 'Start a booking (runs in the background; read the status next)',
          parameters: [key],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/BookingRequest' } } } },
          responses: {
            202: { description: 'Accepted; read GET /v1/bookings/{key}' },
            409: { description: 'Another booking is running; try again in a minute' },
            422: { description: 'Not started: the request needs fixing (see reason and issues)' },
            503: { description: 'Live submissions are turned off' },
          },
        },
      },
      '/v1/bookings/{key}': {
        get: {
          operationId: 'getBookingStatus',
          summary: 'Status of a booking started with this Idempotency-Key',
          parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'running, or the recorded result (state, reason, spectoraShown price)' }, 404: { description: 'No such booking' } },
        },
      },
      '/v1/schema': {
        get: { operationId: 'getBookingRules', summary: 'Bookable services, add-ons, request fields and rules',
               responses: { 200: { description: 'The request schema and rules' } } },
      },
    },
  };
}
