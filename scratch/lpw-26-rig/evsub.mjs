// evsub.mjs <port> <db> <seconds> <query>... — subscribe over v1.json and print every message.
const [port, db, seconds, ...queries] = process.argv.slice(2);
const r = await fetch(`http://127.0.0.1:${port}/v1/identity`, { method: 'POST' });
const token = (await r.json()).token;
const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/database/${db}/subscribe?token=${encodeURIComponent(token)}`, ['v1.json.spacetimedb']);
ws.addEventListener('open', () => ws.send(JSON.stringify({ Subscribe: { query_strings: queries, request_id: 1 } })));
ws.addEventListener('message', (ev) => {
  const t = String(ev.data);
  if (t.includes('IdentityToken')) return;
  console.log(`${process.argv[1].split('/').pop()} ${performance.now().toFixed(0)}ms ${t.length}B ${t.slice(0, 520)}`);
});
setTimeout(() => process.exit(0), Number(seconds) * 1000);
