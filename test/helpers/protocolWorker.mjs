// A separate OS process standing in for one booking worker. Connects as truss_app, waits for a shared
// start instant so every worker fires together, then runs the database side of the booking protocol for
// each job spec it was given:
//   admit → (hold mode) stop here, keeping the browser session open
//         → record a clear duplicate check → (submit mode) reserve → complete 'requested' → end session
//                                          → (abandon mode) end session as BLOCKED, no submission
// With --retry it re-tries admission while another worker holds the browser session.
// Prints a JSON array of per-job results on stdout.
import pg from 'pg';

const [url, startAtMs, mode, retry, ...specs] = process.argv.slice(2);
const pool = new pg.Pool({ connectionString: url, max: 1 });
const q = async (sql, params) => (await pool.query(sql, params)).rows[0].r;
const results = [];
try {
  await pool.query('SELECT 1'); // connect before the barrier
  while (Date.now() < Number(startAtMs)) { /* spin to the shared start instant */ }
  for (const raw of specs) {
    const spec = JSON.parse(raw);
    let a;
    for (let i = 0; i < 400; i++) {
      a = await q('SELECT safety.app_admit_job($1, $2, $3, $4, $5, $6, $7, $8) AS r',
        [spec.key, 'booking', JSON.stringify({ spec: spec.key }), spec.hash, JSON.stringify(spec.property),
         spec.customerKeys, spec.appointmentAt, `pid-${process.pid}`]);
      if (a.admitted || retry !== 'retry' || a.reason !== 'browser_session_active') break;
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 10));
    }
    if (!a.admitted) { results.push({ key: spec.key, admitted: false, reason: a.reason }); continue; }
    const job = a.job_id, token = a.token;
    if (mode === 'hold') { results.push({ key: spec.key, admitted: true, reserved: null, reason: null }); continue; }
    await q('SELECT safety.app_record_duplicate_check($1, $2, $3, $4) AS r', [job, token, 'clear', '{}']);
    let reserved = null;
    if (mode === 'submit') {
      reserved = await q('SELECT safety.app_reserve_submission($1, $2) AS r', [job, token]);
      if (reserved.ok) {
        await q(`SELECT safety.app_complete_attempt($1, $2, 'requested', '{}'::jsonb, $3) AS r`,
          [reserved.attempt_id, token, `INS-${reserved.attempt_id}`]);
        await q('SELECT safety.app_end_session($1, $2, NULL, $3) AS r', [job, token, 'completed']);
      } else {
        await q('SELECT safety.app_end_session($1, $2, $3, $4) AS r', [job, token, 'BLOCKED', reserved.reason]);
      }
    } else {
      await q('SELECT safety.app_end_session($1, $2, $3, $4) AS r', [job, token, 'BLOCKED', 'abandoned_before_submit']);
    }
    results.push({ key: spec.key, admitted: true, reserved: reserved ? reserved.ok : null, reason: reserved?.reason ?? null });
  }
  process.stdout.write(JSON.stringify(results));
} finally {
  await pool.end();
}
