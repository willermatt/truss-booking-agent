/**
 * Duplicate protection. Spectora's read-only API is checked before any browser opens; exact matches are
 * blocked as duplicates, possible matches are blocked as ambiguous (manual booking), and the check fails
 * closed. The database independently blocks duplicates and ambiguous matches among its own jobs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgCluster } from './helpers/pgCluster.js';
import { TestEnv } from './helpers/env.js';
import { SpectoraReadApi } from '../src/spectora/readApi.js';

let cluster: PgCluster;
beforeAll(async () => { cluster = await PgCluster.create(); });
afterAll(async () => { await cluster?.destroy(); });

const at = (req: { appointment: { date: string } }, shiftDays = 0, time = '08:00') =>
  new Date(new Date(`${req.appointment.date}T${time}:00-07:00`).getTime() + shiftDays * 86_400_000).toISOString();

const other = { firstName: 'Someone', lastName: 'Else', email: 'else@example.com', phone: '4805550000' };

describe('Spectora duplicate check', () => {
  it('blocks the same property written differently, before any browser opens', async () => {
    const env = await TestEnv.create(cluster);
    const req = env.request({ property: { street: '1700 W. Washington St.', city: 'Phoenix', state: 'AZ', zip: '85007' } });
    env.spectora.add({ id: 'S-1', datetime: at(req, 2), address: '1700 West Washington Street', zip: '85007', buyer: other });
    const res = await env.runner().run(env.key(), req);
    expect(res).toMatchObject({ state: 'BLOCKED', reason: 'potential_duplicate' });
    expect(res.duplicates?.[0]).toMatchObject({ inspectionId: 'S-1', kind: 'duplicate', property: 'same' });
    expect(env.driver.startCalls).toBe(0);
    expect(await env.attemptCount()).toBe(0);
  });

  it('does not treat a different directional, unit, ZIP or street type as the same property', async () => {
    const env = await TestEnv.create(cluster);
    const variants: [string, (n: number) => Record<string, unknown>][] = [
      ['E vs W', (n) => ({ address: `${n} E Washington St`, unit: '4B', zip: '85007' })],
      ['Ave vs St', (n) => ({ address: `${n} W Washington Ave`, unit: '4B', zip: '85007' })],
      ['other ZIP', (n) => ({ address: `${n} W Washington St`, unit: '4B', zip: '85008' })],
      ['other unit', (n) => ({ address: `${n} W Washington St`, unit: '4C', zip: '85007' })],
    ];
    for (const [i, [why, existing]] of variants.entries()) {
      const n = 1700 + 2 * i; // a different building per variant, so the database's own check stays out of it
      const req = env.request({ property: { street: `${n} W Washington St`, unit: '4B', city: 'Phoenix', state: 'AZ', zip: '85007' } });
      env.spectora.add({ id: why, datetime: at(req), buyer: other, ...existing(n) } as never);
      expect((await env.runner().run(env.key(), req)).state, why).toBe('REQUESTED');
      await env.advanceMinutes(62);
    }
    expect(env.driver.submitCalls).toBe(4);
  });

  it('blocks possible matches as ambiguous, requiring manual booking', async () => {
    const env = await TestEnv.create(cluster);
    const base = { street: '1700 W Washington St', unit: '4B', city: 'Phoenix', state: 'AZ', zip: '85007' };
    const client = { firstName: 'Dana', lastName: 'ONeil', email: 'client-a@example.com', phone: '602-555-7777' };
    const cases: [string, number, Record<string, unknown>][] = [
      ['directional missing', -3, { address: '1700 Washington St', unit: '4B', zip: '85007', buyer: other }],
      ['street type missing', -3, { address: '1700 W Washington', unit: '4B', zip: '85007', buyer: other }],
      ['unit missing', -3, { address: '1700 W Washington St', zip: '85007', buyer: other }],
      ['ZIP missing', -3, { address: '1700 W Washington St', unit: '4B', zip: '', buyer: other }],
      ['same customer email, other property, same appointment', 0, { address: '9 Other Rd', zip: '85251', buyer: { ...other, email: 'CLIENT-A@example.com' } }],
      ['same customer phone, other property, same appointment', 0, { address: '9 Other Rd', zip: '85251', buyer: { ...other, phone: '(602) 555-7777' } }],
      ['same customer name, other property, same appointment', 0, { address: '9 Other Rd', zip: '85251', buyer: { ...other, firstName: 'Dana', lastName: "O'Neil" } }],
      ['no address on record, same customer', 2, { buyer: { ...other, email: 'client-a@example.com' } }],
      ['no address on record, same appointment', 0, { buyer: other }],
    ];
    for (const [why, shift, existing] of cases) {
      env.spectora.inspections = [];
      const req = env.request({ property: base, customer: client });
      env.spectora.add({ id: why, datetime: at(req, shift), ...existing } as never);
      const res = await env.runner().run(env.key(), req);
      expect(res, why).toMatchObject({ state: 'BLOCKED', reason: 'ambiguous_match_manual_booking_required' });
      expect(res.duplicates?.[0].kind, why).toBe('ambiguous');
    }
    expect(env.driver.startCalls).toBe(0);
  });

  it('the same customer may book another property, at another time', async () => {
    const env = await TestEnv.create(cluster);
    const cases: [string, number, string, (c: Record<string, string>) => Record<string, unknown> | null][] = [
      ['same email, other property, 3 days earlier', -3, '08:00', (c) => ({ ...other, email: c.email })],
      ['same phone, other property, same day 11:30', 0, '11:30', (c) => ({ ...other, phone: c.phone })],
      ['same name, other property, next day', 1, '08:00', (c) => ({ ...other, firstName: c.firstName, lastName: c.lastName })],
      ['no address on record, someone else, another time', 2, '11:30', () => null],
    ];
    for (const [i, [why, shift, time, buyerOf]] of cases.entries()) {
      env.spectora.inspections = [];
      const client = { firstName: `Dana${i}`, lastName: 'ONeil', email: `client-${i}@example.com`, phone: `60255577${i}0` };
      const buyer = buyerOf(client);
      const req = env.request({ customer: client });
      env.spectora.add({ id: why, datetime: at(req, shift, time), ...(buyer ? { address: '9 Other Rd', zip: '85251', buyer } : { buyer: other }) } as never);
      expect((await env.runner().run(env.key(), req)).state, why).toBe('REQUESTED');
      await env.advanceMinutes(62);
    }
  });

  it('the same property is still a duplicate whoever the customer is and whatever the time', async () => {
    const env = await TestEnv.create(cluster);
    const req = env.request({ property: { street: '1700 W Washington St', city: 'Phoenix', state: 'AZ', zip: '85007' } });
    env.spectora.add({ id: 'SAME-HOUSE', datetime: at(req, 9, '11:30'), address: '1700 West Washington Street', zip: '85007', buyer: other });
    expect(await env.runner().run(env.key(), req)).toMatchObject({ state: 'BLOCKED', reason: 'potential_duplicate' });
  });

  it('ignores canceled inspections and those outside ±14 days (a warranty inspection a year later)', async () => {
    const env = await TestEnv.create(cluster);
    const req = env.request({ property: { street: '42 N Builder Way', city: 'Phoenix', state: 'AZ', zip: '85050' } });
    env.spectora.add({ id: 'OLD', datetime: at(req, -340), address: '42 N Builder Way', zip: '85050', buyer: other });
    env.spectora.add({ id: 'CXL', datetime: at(req), address: '42 N Builder Way', zip: '85050', canceledAt: '2026-10-20T10:00:00Z' });
    expect((await env.runner().run(env.key(), req)).state).toBe('REQUESTED');
  });

  it('fails closed when Spectora is unreachable, erroring, out of quota, or not configured', async () => {
    const env = await TestEnv.create(cluster);
    for (const mode of ['network_down', 'server_error', 'quota_exhausted'] as const) {
      env.spectora.mode = mode;
      env.spectora.calls = [];
      const res = await env.runner().run(env.key(), env.request());
      expect(res, mode).toMatchObject({ state: 'BLOCKED', reason: 'duplicate_check_unavailable' });
      expect(env.spectora.calls.length, mode).toBe(mode === 'quota_exhausted' ? 1 : 3); // bounded read retries
    }
    expect((await env.runner({ spectora: null }).run(env.key(), env.request())).reason).toBe('duplicate_check_unavailable');
    expect(env.driver.startCalls).toBe(0);
    expect(await env.attemptCount()).toBe(0);
  });
});

describe('database duplicate check (independent of Spectora)', () => {
  it('blocks the same property while Spectora has not shown the first booking yet', async () => {
    const env = await TestEnv.create(cluster);
    const req = env.request();
    expect((await env.runner().run(env.key('a'), req)).state).toBe('REQUESTED');
    await env.advanceMinutes(62);
    const again = await env.runner().run(env.key('b'), { ...req, customer: { ...other } });
    expect(again).toMatchObject({ state: 'BLOCKED', reason: 'local_duplicate' });
    expect(env.driver.submitCalls).toBe(1);
  });

  it('blocks possible matches among its own jobs as ambiguous, and allows E vs W', async () => {
    const env = await TestEnv.create(cluster);
    const first = env.request({ property: { street: '1700 W Washington St', city: 'Phoenix', state: 'AZ', zip: '85007' } });
    expect((await env.runner().run(env.key(), first)).state).toBe('REQUESTED');
    await env.advanceMinutes(62);
    const eastSide = env.request({ property: { street: '1700 E Washington St', city: 'Phoenix', state: 'AZ', zip: '85007' } });
    expect((await env.runner().run(env.key(), eastSide)).state).toBe('REQUESTED');
    await env.setTime('2026-11-03T08:00:00-07:00');
    const noType = env.request({ property: { street: '1700 W Washington', city: 'Phoenix', state: 'AZ', zip: '85007' } });
    expect(await env.runner().run(env.key(), noType)).toMatchObject({ state: 'BLOCKED', reason: 'local_ambiguous_match' });
    // The same customer at another property: the same appointment is ambiguous, another time is fine.
    const sameEmail = env.request({ customer: { ...first.customer }, appointment: first.appointment });
    expect(await env.runner().run(env.key(), sameEmail)).toMatchObject({ state: 'BLOCKED', reason: 'local_ambiguous_match' });
    const laterSameDay = env.request({ customer: { ...first.customer }, appointment: { ...first.appointment, time: '11:30' } });
    expect((await env.runner().run(env.key(), laterSameDay)).state).toBe('REQUESTED');
  });

  it('replays an idempotency key without doing anything; refuses the key for a different request', async () => {
    const env = await TestEnv.create(cluster);
    const key = env.key();
    const req = env.request();
    const first = await env.runner().run(key, req);
    expect(first.state).toBe('REQUESTED');
    const callsBefore = env.spectora.calls.length;
    expect(await env.runner().run(key, req)).toMatchObject({ jobId: first.jobId, state: 'REQUESTED', replayed: true });
    expect(env.driver.startCalls).toBe(1);
    expect(env.spectora.calls.length).toBe(callsBefore);
    expect(await env.jobCount()).toBe(1);
    expect((await env.runner().run(key, { ...req, notes: 'different' })).reason).toBe('idempotency_key_reused_with_different_request');
  });

  it('refuses to reserve without a clear duplicate check, or with one older than 15 minutes', async () => {
    const env = await TestEnv.create(cluster);
    const unchecked = await env.admit();
    expect(await env.gate.reserve(unchecked)).toMatchObject({ ok: false, reason: 'job_not_ready' });
    await env.gate.endSession(unchecked, 'BLOCKED', 'test');
    // A live session cannot last 15 minutes, so this branch is defense in depth: backdate the check directly.
    const h = await env.ready();
    await env.db.pool('superuser').query(
      `UPDATE safety.jobs SET dup_checked_at = dup_checked_at - interval '16 minutes' WHERE id = $1`, [h.jobId]);
    expect(await env.gate.reserve(h)).toMatchObject({ ok: false, reason: 'duplicate_check_missing_or_stale' });
    expect(await env.attemptCount()).toBe(0);
  });

  it('the Spectora client cannot send anything but GET', () => {
    const api = new SpectoraReadApi({ apiKey: 'k', fetch: async () => { throw new Error('unused'); } });
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(api)).filter((m) => m !== 'constructor');
    expect(methods.sort()).toEqual(['get', 'listInspections']);
  });
});
