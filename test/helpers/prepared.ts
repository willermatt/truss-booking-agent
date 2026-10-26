/** Builds a PreparedJob the way the runner does (schema, service mapping, price), for unit tests. */
import { BookingRequestSchema, appointmentInstant } from '../../src/booking/schema.js';
import { resolveServices } from '../../src/booking/services.js';
import type { PreparedJob } from '../../src/booking/driver.js';

export function preparedJob(raw: unknown, extra: Partial<PreparedJob> = {}): PreparedJob {
  const request = BookingRequestSchema.parse(raw);
  const services = resolveServices(request.services, request.addOns ?? []);
  if (!services.ok) throw new Error(`services: ${services.issues.join('; ')}`);
  return { jobId: 'j', mode: 'booking', request, services: services.value,
           appointmentAt: appointmentInstant(request.appointment.date, request.appointment.time)!, ...extra };
}
