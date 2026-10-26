import { z } from 'zod';
import { PHOENIX_UTC_OFFSET } from '../config.js';

const digits = (v: string) => v.replace(/\D/g, '');

const Phone = z
  .string()
  .trim()
  .refine((v) => {
    const d = digits(v);
    return d.length === 10 || (d.length === 11 && d.startsWith('1'));
  }, 'phone must be a 10-digit US number');

const Name = z.string().trim().min(1).max(80);

/**
 * The booking request accepted from the owner or an AI client. `.strict()` everywhere: unknown fields
 * are rejected rather than ignored, so a request cannot smuggle in fields such as "force",
 * "overrideLimits" or "skipDuplicateCheck". There are no such fields anywhere in the system.
 *
 * Square footage and year built are optional. When given, they are typed over Spectora's property lookup
 * values; when left out, the lookup values are used as Spectora fills them (never invented here). If
 * Spectora then refuses Step 1, the job stops as NEEDS_INPUT naming what is missing.
 */
export const BookingRequestSchema = z
  .object({
    property: z
      .object({
        street: z.string().trim().min(3).max(200).describe('Street line only: number, direction, name and type, e.g. "1700 W Washington St". No unit, city or ZIP here.'),
        unit: z.string().trim().max(20).optional().describe('Unit or apartment, e.g. "4B". Omit if none.'),
        city: z.string().trim().min(2).max(80),
        state: z.string().trim().regex(/^[A-Za-z]{2}$/, 'state must be a 2-letter code').describe('Two-letter state; Truss serves AZ.'),
        zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/, 'zip must be 5 digits'),
      })
      .strict()
      .describe('The property to inspect, exactly as the customer gave it.'),
    customer: z
      .object({ firstName: Name, lastName: Name, email: z.email().max(200), phone: Phone.describe('10-digit US phone') })
      .strict()
      .describe('The client (buyer). All four fields are required; never invent them.'),
    appointment: z
      .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD').describe('YYYY-MM-DD'),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must be HH:MM, 24-hour, Arizona time')
          .describe('HH:MM, 24-hour, Arizona time, e.g. "08:00". Must be an offered slot; nothing else is substituted.'),
      })
      .strict(),
    services: z.array(z.string().trim().min(1).max(100)).min(1).max(5)
      .describe('Exactly one primary service by name or alias (see /v1/schema services); add-ons may also be listed here.'),
    addOns: z.array(z.string().trim().min(1).max(100)).max(10).optional().describe('Add-ons offered with that service.'),
    squareFeet: z.number().int().min(100).max(100_000).optional()
      .describe('Living area in square feet, if the customer gave it. Left out: Spectora\'s own property lookup value is used.'),
    yearBuilt: z.number().int().min(1800).max(2100).optional()
      .describe('Year the home was built, if the customer gave it. Left out: Spectora\'s own property lookup value is used.'),
    foundation: z.enum(['basement', 'slab', 'crawlspace']).optional().describe('Only if the customer said.'),
    agent: z
      .object({
        firstName: Name,
        lastName: Name,
        email: z.email().max(200).optional(),
        phone: Phone.optional(),
        agency: z.string().trim().max(120).optional(),
      })
      .strict()
      .optional(),
    notes: z.string().max(2000).optional().describe('Anything else the customer wants Truss to know (gate codes, access, questions).'),
    /** Explicit, recorded customer consent. Boxes stay unticked unless the matching value is true. */
    smsConsent: z
      .object({
        transactional: z.boolean().describe('True only if the customer explicitly agreed to texts about this booking.'),
        marketing: z.boolean().describe('True only if the customer explicitly agreed to marketing texts.'),
        evidence: z.string().trim().min(10).max(500).optional()
          .describe('Required when either value is true: how and when the customer agreed, in their words where possible.'),
      })
      .strict()
      .refine((c) => !(c.transactional || c.marketing) || !!c.evidence, {
        message: 'smsConsent.evidence is required when consent is true: record how and when the customer agreed',
        path: ['evidence'],
      })
      .optional()
      .describe('Leave out unless the customer was asked. Boxes stay unticked unless a value is true and evidence is recorded.'),
  })
  .strict();

export type BookingRequest = z.infer<typeof BookingRequestSchema>;

/** Converts the requested Arizona-local date and time to an instant. Returns null for impossible dates. */
export function appointmentInstant(date: string, time: string): Date | null {
  const d = new Date(`${date}T${time}:00${PHOENIX_UTC_OFFSET}`);
  if (Number.isNaN(d.getTime())) return null;
  // Reject calendar overflow such as 2026-02-30 (JS would roll it into March).
  const local = new Date(d.getTime() - 7 * 3600_000).toISOString();
  if (local.slice(0, 10) !== date || local.slice(11, 16) !== time) return null;
  return d;
}

/** "08:00" → "8:00 AM", the way Spectora's calendar labels slots. */
export function slotLabel(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
