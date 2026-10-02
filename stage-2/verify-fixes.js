const { spawn } = require('child_process');
const axios = require('axios');

const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;

async function req(method, path, body, headers = {}) {
  try {
    const resp = await axios({
      method,
      url: BASE + path,
      data: body !== undefined ? body : undefined,
      headers,
      validateStatus: () => true
    });
    return { status: resp.status, body: resp.data, raw: typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data) };
  } catch (e) {
    if (e.response) {
      return { status: e.response.status, body: e.response.data, raw: typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data) };
    }
    throw e;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await req('GET', '/health');
      if (r.status === 200) return;
    } catch (e) {}
    await sleep(200);
  }
  throw new Error('server did not start');
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.log(`  FAIL: ${name} ${detail ? '- ' + detail : ''}`); }
}

async function main() {
  const server = spawn('node', ['src/index.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  server.stdout.on('data', d => (serverLog += d));
  server.stderr.on('data', d => (serverLog += d));

  try {
    await waitForServer();
    console.log('Server up on', PORT);

    // ---------- Test 1: lookup.html status text ----------
    console.log('\n[1] lookup.html status text');
    const fs = require('fs');
    const html = fs.readFileSync(__dirname + '/public/lookup.html', 'utf8');
    check('no "Status: " prefix in lookupReservation', !/Status: \$\{data\.status\}/.test(html));
    const statusAssignments = html.match(/reservationStatus\.textContent\s*=\s*[^;\n]+/g) || [];
    check('both status assignments are bare data.status',
      statusAssignments.length === 2 && statusAssignments.every(s => /reservationStatus\.textContent\s*=\s*data\.status/.test(s)),
      JSON.stringify(statusAssignments));

    // ---------- Test 2: import preserves tokens ----------
    console.log('\n[2] import preserves login tokens');
    // reset with a user
    const fixture = {
      users: [{ id: 'u_1', email: 'a@b.com', password_hash: 'x', display_name: 'A', password: 'password123' }],
      restaurants: [{
        id: 'r_1', name: 'R', timezone: 'UTC', slot_minutes: 30,
        reservation_duration_minutes: 60, cancellation_cutoff_minutes: 0,
        opening_hours: [{ weekday: 'thu', opens: '18:00', closes: '22:00' }],
        tables: [{ id: 't_1', label: 'T1', capacity: 4 }, { id: 't_2', label: 'T2', capacity: 4 }],
        combinable: [['t_1', 't_2']]
      }],
      reservations: []
    };
    let r = await req('POST', '/_test/reset', fixture);
    check('reset ok', r.status === 204, String(r.status));

    r = await req('POST', '/auth/login', { email: 'a@b.com', password: 'password123' });
    check('login ok', r.status === 200, String(r.status));
    const oldToken = r.body && r.body.token;
    check('got token', !!oldToken);

    r = await req('GET', '/reservations', null, { Authorization: `Bearer ${oldToken}` });
    check('GET /reservations with old token = 200 (pre-import)', r.status === 200, String(r.status));

    // export
    r = await req('GET', '/_test/export');
    check('export ok', r.status === 200, String(r.status));
    const exported = r.body;

    // fresh reset (clears users)
    r = await req('POST', '/_test/reset', { users: [], restaurants: [], reservations: [] });
    check('fresh reset ok', r.status === 204, String(r.status));

    // import the export
    r = await req('POST', '/_test/import', exported);
    check('import ok', r.status === 204, String(r.status));

    r = await req('GET', '/reservations', null, { Authorization: `Bearer ${oldToken}` });
    check('GET /reservations with old token = 200 (post-import)', r.status === 200, String(r.status) + ' ' + (r.body && r.body.error && r.body.error.code));

    // ---------- Test 3: combination booking ----------
    console.log('\n[3] combination booking');
    // reset with combinable fixture
    const comboFixture = {
      users: [{ id: 'u_2', email: 'c@d.com', password_hash: 'x', display_name: 'C', password: 'password123' }],
      restaurants: [{
        id: 'r_anker', name: 'Anker', timezone: 'UTC', slot_minutes: 30,
        reservation_duration_minutes: 60, cancellation_cutoff_minutes: 0,
        opening_hours: [{ weekday: 'thu', opens: '18:00', closes: '22:00' }],
        tables: [{ id: 't_1', label: 'T1', capacity: 3 }, { id: 't_2', label: 'T2', capacity: 3 }, { id: 't_3', label: 'T3', capacity: 4 }],
        combinable: [['t_1', 't_2']]
      }],
      reservations: []
    };
    r = await req('POST', '/_test/reset', comboFixture);
    check('combo reset ok', r.status === 204, String(r.status));

    r = await req('POST', '/auth/login', { email: 'c@d.com', password: 'password123' });
    check('combo login ok', r.status === 200, String(r.status));
    const token2 = r.body && r.body.token;

    // 2026-09-24 is a Thursday
    r = await req('POST', '/reservations', {
      restaurant_id: 'r_anker', table_ids: ['t_1', 't_2'],
      starts_at_local: '2026-09-24T19:00', party_size: 6
    }, { Authorization: `Bearer ${token2}`, 'Idempotency-Key': 'combo-1' });
    check('POST table_ids combo = 201', r.status === 201, String(r.status) + ' ' + JSON.stringify(r.body));
    check('response has table_ids [t_1,t_2]', r.body && Array.isArray(r.body.table_ids) && r.body.table_ids.join(',') === 't_1,t_2', JSON.stringify(r.body && r.body.table_ids));
    check('response omits table_id for combo', r.body && !('table_id' in r.body), JSON.stringify(r.body));

    // single-table still works and includes table_id
    r = await req('POST', '/reservations', {
      restaurant_id: 'r_anker', table_id: 't_3',
      starts_at_local: '2026-09-24T19:00', party_size: 4
    }, { Authorization: `Bearer ${token2}`, 'Idempotency-Key': 'single-1' });
    check('POST table_id single = 201', r.status === 201, String(r.status) + ' ' + JSON.stringify(r.body));
    check('single response has table_id', r.body && r.body.table_id === 't_3', JSON.stringify(r.body && r.body.table_id));
    check('single response has table_ids [t_3]', r.body && Array.isArray(r.body.table_ids) && r.body.table_ids[0] === 't_3', JSON.stringify(r.body && r.body.table_ids));

    // non-combinable pair -> 422 combination_not_allowed
    r = await req('POST', '/reservations', {
      restaurant_id: 'r_anker', table_ids: ['t_1', 't_3'],
      starts_at_local: '2026-09-24T19:00', party_size: 4
    }, { Authorization: `Bearer ${token2}`, 'Idempotency-Key': 'bad-pair-1' });
    check('non-combinable pair = 422 combination_not_allowed', r.status === 422 && r.body && r.body.error && r.body.error.code === 'combination_not_allowed', String(r.status) + ' ' + JSON.stringify(r.body));

    // both table_id and table_ids -> 422 validation_failed
    r = await req('POST', '/reservations', {
      restaurant_id: 'r_anker', table_id: 't_1', table_ids: ['t_1', 't_2'],
      starts_at_local: '2026-09-24T19:00', party_size: 4
    }, { Authorization: `Bearer ${token2}`, 'Idempotency-Key': 'both-1' });
    check('both table_id+table_ids = 422 validation_failed', r.status === 422 && r.body && r.body.error && r.body.error.code === 'validation_failed', String(r.status) + ' ' + JSON.stringify(r.body));

    // duplicate table id -> 422 validation_failed
    r = await req('POST', '/reservations', {
      restaurant_id: 'r_anker', table_ids: ['t_1', 't_1'],
      starts_at_local: '2026-09-24T19:00', party_size: 4
    }, { Authorization: `Bearer ${token2}`, 'Idempotency-Key': 'dup-1' });
    check('duplicate table id = 422 validation_failed', r.status === 422 && r.body && r.body.error && r.body.error.code === 'validation_failed', String(r.status) + ' ' + JSON.stringify(r.body));

    // party exceeds combined capacity -> 422 party_exceeds_capacity
    r = await req('POST', '/reservations', {
      restaurant_id: 'r_anker', table_ids: ['t_1', 't_2'],
      starts_at_local: '2026-09-24T19:00', party_size: 7
    }, { Authorization: `Bearer ${token2}`, 'Idempotency-Key': 'cap-1' });
    check('party exceeds capacity = 422 party_exceeds_capacity', r.status === 422 && r.body && r.body.error && r.body.error.code === 'party_exceeds_capacity', String(r.status) + ' ' + JSON.stringify(r.body));

    // overlapping combo -> 409 table_unavailable (t_1/t_2 already booked at 19:00)
    r = await req('POST', '/reservations', {
      restaurant_id: 'r_anker', table_ids: ['t_1', 't_2'],
      starts_at_local: '2026-09-24T19:30', party_size: 6
    }, { Authorization: `Bearer ${token2}`, 'Idempotency-Key': 'overlap-1' });
    check('overlapping combo = 409 table_unavailable', r.status === 409 && r.body && r.body.error && r.body.error.code === 'table_unavailable', String(r.status) + ' ' + JSON.stringify(r.body));

    // availability has available_options (use 20:00, which is free)
    r = await req('GET', '/availability?restaurant_id=r_anker&date=2026-09-24&party_size=6');
    check('availability ok', r.status === 200, String(r.status));
    const slot = r.body && r.body.slots && r.body.slots.find(s => s.starts_at_local === '2026-09-24T20:00');
    check('slot has available_options', slot && Array.isArray(slot.available_options), JSON.stringify(slot));
    if (slot && slot.available_options) {
      const comboOpt = slot.available_options.find(o => o.table_ids && o.table_ids.length === 2);
      check('combo option present with capacity 6', comboOpt && comboOpt.capacity === 6 && comboOpt.table_ids.join(',') === 't_1,t_2', JSON.stringify(slot.available_options));
      // 19:00 slot should NOT offer the combo (t_1/t_2 taken)
      const takenSlot = r.body.slots.find(s => s.starts_at_local === '2026-09-24T19:00');
      const takenCombo = takenSlot && takenSlot.available_options && takenSlot.available_options.find(o => o.table_ids && o.table_ids.length === 2);
      check('19:00 slot does not offer combo (tables taken)', !takenCombo, JSON.stringify(takenSlot && takenSlot.available_options));
    }

    console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  } finally {
    server.kill('SIGTERM');
    await sleep(300);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
