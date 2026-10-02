const { spawn } = require('child_process');
const axios = require('/home/kiter/band-work/result/stage-2/node_modules/axios');

const S1_PORT = 8101;
const S2_PORT = 8102;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function startServer(dir, port) {
  const server = spawn('node', ['src/index.js'], {
    cwd: dir,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  server.stdout.on('data', d => (log += d));
  server.stderr.on('data', d => (log += d));
  for (let i = 0; i < 50; i++) {
    try {
      const r = await axios.get(`http://127.0.0.1:${port}/health`);
      if (r.status === 200) return { server, log: () => log };
    } catch (e) {}
    await sleep(200);
  }
  server.kill();
  throw new Error(`server on ${port} did not start`);
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.log(`  FAIL: ${name} ${detail ? '- ' + detail : ''}`); }
}

async function main() {
  const s1 = await startServer(__dirname + '/stage-1', S1_PORT);
  const s2 = await startServer(__dirname + '/stage-2', S2_PORT);
  const S1 = `http://127.0.0.1:${S1_PORT}`;
  const S2 = `http://127.0.0.1:${S2_PORT}`;

  try {
    console.log('Cross-stage token survival test');

    // 1. Reset stage-1 with a user
    const fixture = {
      users: [{ id: 'u_1', email: 'a@b.com', password_hash: 'x', display_name: 'A', password: 'password123' }],
      restaurants: [{
        id: 'r_1', name: 'R', timezone: 'UTC', slot_minutes: 30,
        reservation_duration_minutes: 60, cancellation_cutoff_minutes: 0,
        opening_hours: [{ weekday: 'thu', opens: '18:00', closes: '22:00' }],
        tables: [{ id: 't_1', label: 'T1', capacity: 4 }]
      }],
      reservations: []
    };
    let r = await axios.post(S1 + '/_test/reset', fixture);
    check('stage-1 reset ok', r.status === 204, String(r.status));

    // 2. Login on stage-1
    r = await axios.post(S1 + '/auth/login', { email: 'a@b.com', password: 'password123' });
    check('stage-1 login ok', r.status === 200, String(r.status));
    const token = r.data.token;
    check('got stage-1 token', !!token);

    // 3. Export from stage-1
    r = await axios.get(S1 + '/_test/export');
    check('stage-1 export ok', r.status === 200, String(r.status));
    check('export contains tokens', r.data.state && r.data.state.tokens && r.data.state.tokens[token] === 'u_1',
      JSON.stringify(r.data.state && r.data.state.tokens));
    const snapshot = r.data;

    // 4. Reset stage-2 (fresh)
    r = await axios.post(S2 + '/_test/reset', { users: [], restaurants: [], reservations: [] });
    check('stage-2 reset ok', r.status === 204, String(r.status));

    // 5. Import the stage-1 snapshot into stage-2
    r = await axios.post(S2 + '/_test/import', snapshot);
    check('stage-2 import ok', r.status === 204, String(r.status));

    // 6. GET /reservations on stage-2 with the stage-1 token
    r = await axios.get(S2 + '/reservations', { headers: { Authorization: `Bearer ${token}` } });
    check('GET /reservations on stage-2 with stage-1 token = 200', r.status === 200,
      String(r.status) + ' ' + JSON.stringify(r.data));

    // 7. Also verify stage-2 export includes tokens
    r = await axios.get(S2 + '/_test/export');
    check('stage-2 export contains tokens', r.data.state && r.data.state.tokens && r.data.state.tokens[token] === 'u_1',
      JSON.stringify(r.data.state && r.data.state.tokens));

    // 8. Verify import without tokens field still works (default {})
    const noTokenSnapshot = { track: 'tablekeeper', format_version: 1, state: { users: {}, restaurants: {}, reservations: {}, idempotencyKeys: {}, exportState: null } };
    r = await axios.post(S2 + '/_test/reset', { users: [], restaurants: [], reservations: [] });
    r = await axios.post(S2 + '/_test/import', noTokenSnapshot);
    check('import without tokens field ok', r.status === 204, String(r.status));
    r = await axios.get(S2 + '/_test/export');
    check('tokens default to {} after import without tokens', r.data.state && r.data.state.tokens && Object.keys(r.data.state.tokens).length === 0,
      JSON.stringify(r.data.state && r.data.state.tokens));

    console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  } finally {
    s1.server.kill('SIGTERM');
    s2.server.kill('SIGTERM');
    await sleep(300);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
