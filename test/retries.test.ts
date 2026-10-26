/**
 * A network failure or timeout during the final submit is an UNKNOWN outcome. It is never retried: not by
 * the runner, not by replaying the job, not by a new job for the same booking. The only ways forward are a
 * read-only Spectora lookup that finds the inspection, or the owner's reconciliation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgCluster } from './helpers/pgCluster.js';
import { TestEnv } from './helpers/env.js';

let cluster: PgCluster;
beforeAll(async () => { cluster = await PgCluster.create(); });
afterAll(async () => { await cluster?.destroy(); });

describe('no blind retries', () => {
  for (const failure of ['network_error', 'timeout'] as const) {
    it(`a ${failure} during submit is recorded UNKNOWN and submit is never called again`, async () => {
      const env = await TestEnv.create(cluster);
      env.driver.setSubmit({ kind: failure });
      const key = env.key();
      const req = env.request();

      const res = await env.runner().run(key, req);
      expect(res.state).toBe('UNKNOWN');
      expect(env.driver.submitCalls).toBe(1);
      expect(await env.status()).toMatchObject({ attempts_today: 1, consecutive_errors: 1, active_session: null });

      env.driver.setSubmit({ kind: 'requested' });
      expect(await env.runner().run(key, req)).toMatchObject({ state: 'UNKNOWN', replayed: true });   // same key: replay only
      await env.advanceMinutes(62);
      // A new key, or a reworded address: nothing books until the UNKNOWN is reconciled.
      expect(await env.runner().run(env.key(), req)).toMatchObject({ state: 'BLOCKED', reason: 'unreconciled_unknown_outcome' });
      const reworded = { ...req, property: { ...req.property, street: req.property.street.replace(' Ln', ' Lane') } };
      expect(await env.runner().run(env.key(), reworded)).toMatchObject({ reason: 'unreconciled_unknown_outcome' });
      // Found in Spectora: the same booking is then a duplicate.
      await env.owner('owner_reconcile', [res.jobId, true, 'S-FOUND', false, 'it is in Spectora']);
      expect(await env.runner().run(env.key(), reworded)).toMatchObject({ state: 'BLOCKED', reason: 'local_duplicate' });
      expect(env.driver.submitCalls).toBe(1);
      expect(await env.attemptCount()).toBe(1);
    });
  }

  it('an unreconciled UNKNOWN stops every booking job (dry runs may still run) and keeps its error counted', async () => {
    const env = await TestEnv.create(cluster);
    env.driver.setSubmit((n) => (n === 1 ? { kind: 'network_error' } : { kind: 'requested' }));
    expect((await env.runner().run(env.key(), env.request())).state).toBe('UNKNOWN');
    for (const t of ['09:11', '10:21', '11:31']) {
      await env.setTime(`2026-11-02T${t}:00-07:00`);
      expect((await env.runner().run(env.key(), env.request())).reason).toBe('unreconciled_unknown_outcome');
    }
    expect((await env.runner().dryRun(env.key(), env.request())).state).toBe('DRY_RUN');
    const h = await env.admit(undefined, 'dry_run');
    expect(await env.gate.reserve(h)).toMatchObject({ ok: false });
    expect(await env.status()).toMatchObject({ unreconciled_unknown: 1, consecutive_errors: 1, attempts_today: 1 });
    expect(env.driver.submitCalls).toBe(1);
    expect(env.driver.startCalls).toBe(2);   // the UNKNOWN job and the dry run; the refused jobs never opened a browser
  });

  it('a read-only lookup can resolve UNKNOWN to REQUESTED when Spectora shows the inspection', async () => {
    const env = await TestEnv.create(cluster);
    const req = env.request();
    const appt = new Date(`${req.appointment.date}T08:00:00-07:00`).toISOString();
    env.driver.setSubmit(() => {
      // The request reached Spectora and created the inspection, but the response was lost.
      env.spectora.add({ id: 'S-LOST-RESPONSE', datetime: appt, address: req.property.street, zip: req.property.zip,
        buyer: { firstName: req.customer.firstName, lastName: req.customer.lastName, email: req.customer.email } });
      return { kind: 'network_error' };
    });
    expect(await env.runner().run(env.key(), req)).toMatchObject({ state: 'REQUESTED', spectoraInspectionId: 'S-LOST-RESPONSE' });
    expect(env.driver.submitCalls).toBe(1);
    expect((await env.status()).consecutive_errors).toBe(1); // the uncertain outcome still counted
  });

  it('an outcome, once recorded, cannot be overwritten; requested needs the inspection id', async () => {
    const env = await TestEnv.create(cluster);
    const h = await env.ready();
    const r = await env.gate.reserve(h);
    if (!r.ok) throw new Error('expected reservation');
    await expect(env.gate.completeAttempt(r.reservation, 'requested', {})).rejects.toThrow(/inspection id/);
    expect((await env.gate.completeAttempt(r.reservation, 'unknown', {})).ok).toBe(true);
    expect(await env.gate.completeAttempt(r.reservation, 'requested', {}, 'FAKE')).toMatchObject({ ok: false, reason: 'outcome_already_recorded' });
    expect((await env.gate.getJob(h.jobId))?.state).toBe('UNKNOWN');
  });

  it('after the owner reconciles "not found", only a NEW job can try again — and it is checked afresh', async () => {
    const env = await TestEnv.create(cluster);
    env.driver.setSubmit({ kind: 'network_error' });
    const req = env.request();
    const first = await env.runner().run(env.key(), req);
    expect(first.state).toBe('UNKNOWN');
    expect(await env.owner('owner_reconcile', [first.jobId, false, null, false, 'checked Spectora: not there']))
      .toMatchObject({ ok: true, state: 'FAILED' });
    env.driver.setSubmit({ kind: 'requested' });
    await env.advanceMinutes(62);
    expect((await env.runner().run(env.key(), req)).state).toBe('REQUESTED');
    expect(env.driver.submitCalls).toBe(2);
  });
});
