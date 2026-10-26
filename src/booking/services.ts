/**
 * Maps requested service names and aliases to the verified Spectora services in config/services.json.
 * Anything that cannot be mapped to exactly one offered service or add-on is NEEDS_INPUT — the agent
 * never guesses.
 */
import { readFileSync } from 'node:fs';

export interface AddOnDef {
  key: string;
  label: string;
  spectoraId: number;
  checkboxId: string;
  checkboxIdVerified: boolean;
  priceUsd: number;
  aliases: string[];
}

export interface ServiceDef {
  key: string;
  label: string;
  spectoraId: number;
  checkboxId: string;
  checkboxIdVerified: boolean;
  basePriceUsd: number;
  aliases: string[];
  addOns: AddOnDef[];
}

export interface ServiceCatalog {
  verifiedAt: string;
  verifiedFrom: string;
  services: ServiceDef[];
  notOffered: { aliases: string[]; reason: string }[];
  ambiguous: { aliases: string[]; reason: string }[];
}

export interface ResolvedServices {
  service: ServiceDef;
  addOns: AddOnDef[];
}

export type ResolveResult = { ok: true; value: ResolvedServices } | { ok: false; issues: string[] };

let cached: ServiceCatalog | null = null;
export function loadCatalog(path = new URL('../../config/services.json', import.meta.url)): ServiceCatalog {
  if (!cached) cached = JSON.parse(readFileSync(path, 'utf8')) as ServiceCatalog;
  return cached;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9/$ -]/g, ' ').replace(/\s+/g, ' ').trim();
const names = (label: string, aliases: string[]) => new Set([norm(label), ...aliases.map(norm)]);

/**
 * Resolves `services` (primary services, and add-ons as a convenience) and `addOns` against the catalog.
 * Exactly one primary service is required; every add-on must be offered with that service.
 */
export function resolveServices(services: string[], addOns: string[] = [], catalog = loadCatalog()): ResolveResult {
  const issues: string[] = [];
  const primaries = new Map<string, ServiceDef>();
  const addOnNames: string[] = [...addOns];

  const blockedReason = (n: string) =>
    catalog.notOffered.find((x) => x.aliases.map(norm).includes(n))?.reason
    ?? catalog.ambiguous.find((x) => x.aliases.map(norm).includes(n))?.reason;

  for (const raw of services) {
    const n = norm(raw);
    const blocked = blockedReason(n);
    if (blocked) { issues.push(`"${raw}": ${blocked}`); continue; }
    const hits = catalog.services.filter((s) => names(s.label, s.aliases).has(n));
    if (hits.length === 1) { primaries.set(hits[0].key, hits[0]); continue; }
    if (hits.length > 1) { issues.push(`"${raw}" matches more than one service`); continue; }
    // Not a primary service: maybe an add-on named in the services list.
    const isAddOn = catalog.services.some((s) => s.addOns.some((a) => names(a.label, a.aliases).has(n)));
    if (isAddOn) addOnNames.push(raw);
    else issues.push(`"${raw}" is not a service Truss offers in the online scheduler`);
  }

  if (primaries.size === 0 && !issues.length) issues.push('no primary inspection service was requested');
  if (primaries.size > 1) {
    issues.push(`more than one primary service requested (${[...primaries.values()].map((s) => s.label).join(', ')}); book one per job`);
  }
  if (issues.length) return { ok: false, issues };

  const service = [...primaries.values()][0];
  const chosen = new Map<string, AddOnDef>();
  for (const raw of addOnNames) {
    const n = norm(raw);
    const blocked = blockedReason(n);
    if (blocked) { issues.push(`"${raw}": ${blocked}`); continue; }
    const hits = service.addOns.filter((a) => names(a.label, a.aliases).has(n));
    if (hits.length === 1) chosen.set(hits[0].key, hits[0]);
    else if (hits.length > 1) issues.push(`"${raw}" matches more than one add-on`);
    else issues.push(`"${raw}" is not offered with ${service.label}`);
  }
  if (issues.length) return { ok: false, issues };
  return { ok: true, value: { service, addOns: [...chosen.values()] } };
}
