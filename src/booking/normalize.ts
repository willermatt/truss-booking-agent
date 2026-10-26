import { createHash } from 'node:crypto';
import { parseAddress, propertyColumns, type ParsedAddress } from './address.js';
import type { BookingRequest } from './schema.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizePhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}

export function normalizeName(first: string, last: string): string {
  return `${first} ${last}`.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

export type CustomerRelation = 'same' | 'ambiguous' | 'different';

/** Same email or phone → same customer. Same full name only → ambiguous. Mirrors safety._customer_relation. */
export function compareCustomer(
  a: { email: string; phone: string; name: string },
  b: { emails: string[]; phones: string[]; names: string[] },
): CustomerRelation {
  if (b.emails.some((e) => normalizeEmail(e) === a.email) || b.phones.some((p) => normalizePhone(p) === a.phone)) {
    return 'same';
  }
  if (b.names.some((n) => n.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim() === a.name)) {
    return 'ambiguous';
  }
  return 'different';
}

export interface Fingerprints {
  property: ParsedAddress;
  propertyColumns: ReturnType<typeof propertyColumns>;
  customer: { email: string; phone: string; name: string };
  customerKeys: string[];
  requestHash: string;
}

/** Stable JSON: object keys sorted, so the same request always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function fingerprints(req: BookingRequest): Fingerprints {
  const property = parseAddress(req.property.street, req.property.unit, req.property.zip);
  const customer = {
    email: normalizeEmail(req.customer.email),
    phone: normalizePhone(req.customer.phone),
    name: normalizeName(req.customer.firstName, req.customer.lastName),
  };
  return {
    property,
    propertyColumns: propertyColumns(property),
    customer,
    customerKeys: [`email:${sha(customer.email)}`, `phone:${sha(customer.phone)}`, `name:${sha(customer.name)}`],
    requestHash: sha(canonical(req)),
  };
}
