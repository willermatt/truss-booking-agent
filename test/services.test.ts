import { describe, expect, it } from 'vitest';
import { resolveServices } from '../src/booking/services.js';

const ok = (s: string[], a: string[] = []) => {
  const r = resolveServices(s, a);
  if (!r.ok) throw new Error(r.issues.join('; '));
  return { service: r.value.service.label, addOns: r.value.addOns.map((x) => x.label).sort() };
};
const issues = (s: string[], a: string[] = []) => {
  const r = resolveServices(s, a);
  if (r.ok) throw new Error('expected NEEDS_INPUT');
  return r.issues.join(' | ');
};

describe('service mapping (verified Spectora labels)', () => {
  it('maps aliases to the verified primary services', () => {
    expect(ok(['home inspection']).service).toBe('Residential Home Inspection');
    expect(ok(['1-year warranty']).service).toBe('1 Year Warranty Inspection');
    expect(ok(['11 month warranty']).service).toBe('1 Year Warranty Inspection');
    expect(ok(['new construction']).service).toBe('New Construction');
    expect(ok(['Condo']).service).toBe('Condo Inspection');
    expect(ok(['Residential Home Inspection']).service).toBe('Residential Home Inspection');
  });

  it('maps add-ons per service, including add-ons named in the services list', () => {
    expect(ok(['home inspection', 'termite', 'mold'], ['pool']).addOns).toEqual(
      ['Mold Inspection - $200', 'Pool/Spa Inspection - $50', 'Termite Inspection - Free']);
    expect(ok(['new construction'], ['pool/spa']).addOns).toEqual(['Pool/Spa - $50']);
    expect(ok(['condo'], ['recallchek']).addOns).toEqual(['Residential Warranty Services - $25']);
  });

  it('returns NEEDS_INPUT for anything it cannot map to exactly one offered option', () => {
    expect(issues(['home inspection', 'sewer'])).toMatch(/Sewer scope is referred out/);
    expect(issues(['multi-family'])).toMatch(/Call for Pricing/);
    expect(issues(['warranty'])).toMatch(/could mean the 1 Year Warranty Inspection service or/);
    expect(issues(['radon'])).toMatch(/not a service Truss offers/);
    expect(issues(['new construction'], ['termite'])).toMatch(/not offered with New Construction/);
    expect(issues(['new construction'], ['mold'])).toMatch(/not offered with New Construction/);
    expect(issues(['home inspection', 'condo'])).toMatch(/more than one primary service/);
    expect(issues(['termite'])).toMatch(/no primary inspection service/);
    expect(issues(['pre-drywall'])).toMatch(/not offered/);
  });
});
