// bot.mjs — one scripted client over the host's v1.json WebSocket protocol (Node 24, no deps).
//
//   node bot.mjs --port 3900 --db lpw26 --name Idle1 --mode idle|walk|watch|press
//        [--zone 10000] [--log out.jsonl] [--seconds 60] [--steps 20] [--token-file f]
//        [--frame-ms 16.7] [--watch-zone 0] [--presses 50] [--raw]
//
// idle : join (and place in a load zone when --zone names one), subscribe own row + zone, send nothing.
// walk : as idle, then walk East/West as the real client does it: one Step in flight, the next
//        sent on the first "frame" (a random 0..frame-ms wait) after the row that acknowledges the
//        one before. --steps per run, alternating direction per run, --runs runs.
// watch: no join; subscribe --watch-zone's characters and stamp every row that arrives.
// press: join, then one Face/Step press from rest at a random phase, --presses times: stamps send
//        and the acknowledging row.
// Every received character row is logged with performance.now() and Date.now().
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]]);
    return acc;
  }, []),
);
const port = Number(args.port ?? 3900);
const db = args.db ?? 'lpw26';
const mode = args.mode ?? 'idle';
const name = args.name ?? 'Bot';
const logPath = args.log;
const seconds = Number(args.seconds ?? 0);
const frameMs = Number(args['frame-ms'] ?? 16.7);
const zoneArg = args.zone === undefined ? undefined : Number(args.zone);
const rng = (() => {
  let a = Number(args.seed ?? 20261126) >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();

const out = [];
const log = (o) => {
  const line = JSON.stringify({ t: performance.now(), wall: Date.now(), ...o });
  if (logPath) out.push(line);
  else if (args.verbose) console.log(line);
};
const flush = () => {
  if (logPath && out.length > 0) {
    appendFileSync(logPath, `${out.join('\n')}\n`);
    out.length = 0;
  }
};
if (logPath) writeFileSync(logPath, '');
setInterval(flush, 1000).unref();

let token;
if (args['token-file']) {
  try {
    token = readFileSync(args['token-file'], 'utf8').trim();
  } catch {
    token = undefined;
  }
}
if (!token) {
  const r = await fetch(`http://127.0.0.1:${port}/v1/identity`, { method: 'POST' });
  token = (await r.json()).token;
  if (args['token-file']) writeFileSync(args['token-file'], token);
}

const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/database/${db}/subscribe?token=${encodeURIComponent(token)}`, [
  'v1.json.spacetimedb',
]);
let reqId = 1;
const send = (o) => ws.send(JSON.stringify(o));
const call = (reducer, argsArr) => {
  const id = reqId++;
  send({ CallReducer: { reducer, args: JSON.stringify(argsArr), request_id: id, flags: 0 } });
  return id;
};
const subscribe = (queries) => send({ Subscribe: { query_strings: queries, request_id: reqId++ } });

let myIdentity;
let myEntity;
let myZone;
let own; // latest own character row
const chars = new Map(); // entity_id -> row
const waiters = [];
const waitFor = (pred, label, softMs) =>
  new Promise((resolve, reject) => {
    const now = pred();
    if (now) {
      resolve(now);
      return;
    }
    const w = { pred, resolve: (v) => (clearTimeout(timer), resolve(v)) };
    // softMs: resolve null on timeout (the caller handles a stall) instead of failing the run.
    const timer = setTimeout(
      () => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        if (softMs) resolve(null);
        else reject(new Error(`timeout waiting for ${label}`));
      },
      softMs ?? 20000,
    );
    waiters.push(w);
  });
const pump = () => {
  for (let i = waiters.length - 1; i >= 0; i--) {
    const v = waiters[i].pred();
    if (v) {
      waiters[i].resolve(v);
      waiters.splice(i, 1);
    }
  }
};

const COLS = {
  player: ['identity', 'entity_id', 'name', 'online', 'last_input_seq', 'discriminator', 'lead_level'],
  character: ['entity_id', 'zone_id', 'tile_x', 'tile_y', 'facing', 'action', 'move_started_at_ms', 'sprite_id', 'move_queue', 'acked_seq'],
};
const FACING = ['North', 'South', 'East', 'West'];
const ACTION = ['Idle', 'Walking', 'Jumping'];
const tagOf = (v, names) => {
  if (Array.isArray(v)) return names[v[0]] ?? String(v[0]);
  if (v && typeof v === 'object') {
    const k = Object.keys(v)[0];
    return /^[0-9]+$/.test(k) ? (names[Number(k)] ?? k) : k;
  }
  return String(v);
};
const parseRow = (table, row) => {
  const r = typeof row === 'string' ? JSON.parse(row) : row;
  if (!COLS[table]) return r;
  const o = Array.isArray(r) ? Object.fromEntries(COLS[table].map((c, i) => [c, r[i]])) : { ...r };
  if (table === 'player') o.identity = Array.isArray(o.identity) ? o.identity[0] : (o.identity?.__identity__ ?? o.identity);
  if (table === 'character') {
    o.facing_name = tagOf(o.facing, FACING);
    o.action_name = tagOf(o.action, ACTION);
  }
  return o;
};
const optionOf = (v) => v; // identities arrive as {__identity__: "0x.."}
const onTables = (tables, kind, reducer) => {
  for (const t of tables ?? []) {
    const tname = t.table_name;
    for (const u of t.updates ?? []) {
      const dels = (u.deletes ?? []).map((r) => parseRow(tname, r));
      const ins = (u.inserts ?? []).map((r) => parseRow(tname, r));
      if (tname === 'player') {
        for (const p of ins) {
          const id = p.identity?.__identity__ ?? p.identity;
          if (myIdentity && String(id).replace(/^0x/, '') === myIdentity.replace(/^0x/, '')) myEntity = p.entity_id;
        }
      }
      if (tname === 'character') {
        const insIds = new Set(ins.map((c) => c.entity_id));
        for (const c of dels) {
          if (!insIds.has(c.entity_id)) {
            chars.delete(c.entity_id);
            log({ ev: 'del', kind, id: c.entity_id, zone: c.zone_id });
          }
        }
        for (const c of ins) {
          const prev = chars.get(c.entity_id);
          chars.set(c.entity_id, c);
          const action = c.action_name;
          const facing = c.facing_name;
          log({
            ev: 'row',
            kind,
            reducer,
            id: c.entity_id,
            zone: c.zone_id,
            x: c.tile_x,
            y: c.tile_y,
            facing,
            action,
            started: c.move_started_at_ms,
            q: c.move_queue.length,
            ack: c.acked_seq,
            moved: prev ? prev.tile_x !== c.tile_x || prev.tile_y !== c.tile_y || prev.zone_id !== c.zone_id : true,
            own: c.entity_id === myEntity,
          });
          if (c.entity_id === myEntity) {
            own = c;
            myZone = c.zone_id;
          }
        }
      }
    }
  }
};

ws.addEventListener('message', (ev) => {
  const text = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
  const m = JSON.parse(text);
  if (args.raw) log({ ev: 'raw', bytes: text.length, head: text.slice(0, Number(args.raw === true ? 600 : args.raw)) });
  if (m.IdentityToken) {
    myIdentity = m.IdentityToken.identity?.__identity__ ?? m.IdentityToken.identity;
    log({ ev: 'identity', identity: myIdentity });
  } else if (m.InitialSubscription) {
    onTables(m.InitialSubscription.database_update?.tables, 'initial');
    log({ ev: 'initial', bytes: text.length });
  } else if (m.TransactionUpdate) {
    const tu = m.TransactionUpdate;
    const reducer = tu.reducer_call?.reducer_name;
    const st = tu.status;
    if (st.Committed) onTables(st.Committed.tables, 'tx', reducer);
    else log({ ev: 'txfail', reducer, status: Object.keys(st)[0], msg: st.Failed ?? null });
    log({ ev: 'tx', reducer, bytes: text.length, status: Object.keys(st)[0], req: tu.reducer_call?.request_id });
  } else if (m.TransactionUpdateLight) {
    onTables(m.TransactionUpdateLight.update?.tables, 'light');
    log({ ev: 'light', bytes: text.length });
  } else {
    log({ ev: 'other', key: Object.keys(m)[0], bytes: text.length });
  }
  pump();
});
ws.addEventListener('close', (e) => {
  log({ ev: 'close', code: e.code });
  flush();
});
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', (e) => rej(new Error(`ws error ${e.message ?? ''}`)));
});
await waitFor(() => myIdentity, 'identity');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PLAYER_QUERY = 'SELECT * FROM player';
const scope = () => {
  const q = [PLAYER_QUERY];
  if (myEntity !== undefined) q.push(`SELECT * FROM character WHERE entity_id = ${myEntity}`);
  if (myZone !== undefined) q.push(`SELECT * FROM character WHERE zone_id = ${myZone}`);
  subscribe(q);
};

if (mode === 'watch') {
  subscribe([`SELECT * FROM character WHERE zone_id = ${Number(args['watch-zone'] ?? 0)}`]);
  log({ ev: 'watching' });
} else {
  subscribe([PLAYER_QUERY]);
  call('join_game', [name]);
  await waitFor(() => myEntity !== undefined, 'own player row');
  scope();
  await waitFor(() => own, 'own character row');
  if (zoneArg !== undefined && zoneArg >= 10000) {
    call('dev_place_in_load_zone', [zoneArg]);
    await waitFor(() => own.zone_id === zoneArg, 'placement');
  }
  scope();
  await sleep(300);
  log({ ev: 'ready', entity: myEntity, zone: own.zone_id, x: own.tile_x, y: own.tile_y });
}

let seq = 0;
const enqueue = (input) => {
  seq += 1;
  const id = call('enqueue_move', [input, seq]);
  log({ ev: 'send', seq, input: JSON.stringify(input), req: id });
  return seq;
};
const dirInput = (kind, dir) => ({ [kind]: { [dir]: [] } });
if (args['raw-char']) ws.addEventListener('message', (ev) => { const t = String(ev.data); if (t.includes('"character"')) log({ ev: 'rawchar', head: t.slice(0, 700) }); });
const atRest = () => own && own.move_queue.length === 0 && own.action_name === 'Idle' && Number(own.acked_seq) === seq;

if (mode === 'walk') {
  const steps = Number(args.steps ?? 20);
  const runs = Number(args.runs ?? 1);
  const dirs = (args.dirs ?? 'east,west').split(',');
  for (let r = 0; r < runs; r++) {
    const dir = dirs[r % dirs.length];
    await waitFor(atRest, 'rest before run');
    await sleep(Number(args['rest-ms'] ?? 900) + rng() * 200);
    log({ ev: 'run-start', run: r, dir });
    for (let s = 0; s < steps; s++) {
      if (args['fault-ms'] && String(args['fault-at'] ?? '').split(',').includes(`${r}:${s}`)) {
        // Fault build only: every movement_tick of the next fault-ms milliseconds fails.
        call('lpw_26_fail_for', [Number(args['fault-ms'])]);
        log({ ev: 'fault-set', run: r, step: s, ms: Number(args['fault-ms']) });
        await sleep(30);
      }
      let want = enqueue(dirInput('step', dir));
      if (args['drop-at-step'] !== undefined && Number(args['drop-at-step']) === s) {
        // Drop the socket with this input still in flight, as a lost connection does.
        await sleep(Number(args['drop-delay-ms'] ?? 60));
        log({ ev: 'drop', step: s, x: own.tile_x, ack: own.acked_seq });
        flush();
        process.exit(0);
      }
      const stallMs = args['stall-ms'] ? Number(args['stall-ms']) : undefined;
      for (;;) {
        const ok = await waitFor(() => Number(own.acked_seq) >= want && own.move_queue.length === 0, `ack ${want}`, stallMs);
        if (ok) break;
        // No row answered the input: say so, then press again, as a player would.
        log({ ev: 'stall', waitedMs: stallMs, unacked: want });
        want = enqueue(dirInput('step', dir));
      }
      await sleep(rng() * frameMs);
    }
    log({ ev: 'run-end', run: r });
  }
  await waitFor(atRest, 'final rest');
  await sleep(1500);
} else if (mode === 'press') {
  const presses = Number(args.presses ?? 50);
  const dirs = ['east', 'west'];
  for (let p = 0; p < presses; p++) {
    await waitFor(atRest, 'rest before press');
    await sleep(Number(args['press-rest-ms'] ?? 700) + rng() * 400);
    const dir = dirs[p % 2];
    log({ ev: 'press', n: p, dir });
    const want = enqueue(dirInput('face', dir));
    await waitFor(() => Number(own.acked_seq) >= want && own.move_queue.length === 0, `ack ${want}`);
    log({ ev: 'press-acked', n: p });
  }
  await sleep(1000);
} else if (seconds > 0) {
  await sleep(seconds * 1000);
} else {
  await new Promise(() => {});
}
flush();
ws.close();
await sleep(200);
flush();
process.exit(0);
