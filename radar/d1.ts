// Drawn map pictures and chart files in Cloudflare D1, through radar.ro-weather.app/_put (17 Nov):
// Backblaze's free 2,500 downloads a day ran out. Squares are packed 16x16 per row (one row per
// square would be past D1's free 100,000 writes a day); see maps-worker/worker.js for the format.
const PUT_KEY = process.env.MAPS_PUT_KEY;
export const d1On = !!PUT_KEY && !!process.env.R2_ENDPOINT;
const PICT = /^((?:tile|nowcast|s3|gfs\/tile)\/.+)\/(\d+)\/(\d+)\/(\d+)(@2x)?\.webp$/;
const BLK = 16, PART_MAX = 1_800_000;
export const pending = new Map<string, Map<string, [number, number, Buffer][]>>();

/** Keep a drawn square for its frame's block; false if the key isn't a map square. */
export function hold(Key: string, buf: Buffer) {
  const m = PICT.exec(Key);
  if (!m) return false;
  const [, g, z, xs, ys, sfx = ""] = m, x = +xs, y = +ys;
  const blk = `${g}/${z}/${Math.floor(x / BLK)}/${Math.floor(y / BLK)}${sfx}`;
  let gm = pending.get(g); if (!gm) pending.set(g, (gm = new Map()));
  let sq = gm.get(blk); if (!sq) gm.set(blk, (sq = []));
  sq.push([x, y, buf]);
  return true;
}

const rec = (k: string, part: number, exp: number, data: Buffer) => {
  const kb = Buffer.from(k), m = Buffer.alloc(2), t = Buffer.alloc(12);
  m.writeUInt16BE(kb.length); t.writeUInt32BE(part, 0); t.writeUInt32BE(exp, 4); t.writeUInt32BE(data.length, 8);
  return [m, kb, t, data];
};
let cleaned = false;
async function send(recs: Buffer[], what: string) {
  // At most ~6 MB a request (big satellite frames were turned away whole), each tried 3 times.
  const MAX = 6_000_000;
  for (let i = 0; i < recs.length; ) {
    const part: Buffer[] = [];
    let size = 0;
    while (i < recs.length && (part.length === 0 || size + recs[i].length + recs[i + 1].length + recs[i + 2].length + recs[i + 3].length < MAX)) {
      for (let k = 0; k < 4; k++) { size += recs[i].length; part.push(recs[i++]); }
    }
    for (let a = 1; ; a++) {
      try { await sendOne(part, what); break; }
      catch (e) { if (a >= 3) throw e; await new Promise((r) => setTimeout(r, 2000 * a)); }
    }
  }
}
async function sendOne(recs: Buffer[], what: string) {
  const r = await fetch(`https://radar.ro-weather.app/_put${cleaned ? "" : "?clean"}`, { method: "POST", headers: { "x-put-key": PUT_KEY! }, body: Buffer.concat(recs), signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`d1 put ${what} ${r.status} ${(await r.text()).slice(0, 200)}`);
  cleaned = true;
}

/** Send one finished frame's squares (packed, split if big); kept `hours` hours. */
// How long each kind is kept, so each pair of free databases (500 MB each) never fills:
// radar 7 h (the lists offer 6 h), forecast 2 h (only the newest run is shown), satellite 13 h
// (the 12 h loop), charts 14 h (the newest run and the one before; runs come every 6 h).
export const keepHours = (k: string) => k.startsWith("snowcover/") ? 72 : k.startsWith("lightning/") ? 26 : k.startsWith("tile/") || k.startsWith("data/") ? 7 : k.startsWith("nowcast/") ? 2 : k.startsWith("s3/") ? 13 : 14;

export async function flush(g: string, _hours?: number) {
  const gm = pending.get(g);
  if (!gm) return;
  const exp = Math.floor(Date.now() / 1000) + keepHours(g) * 3600;
  const recs: Buffer[] = [];
  for (const [blk, sq] of gm) {
    let part = 0;
    for (let i = 0; i < sq.length; ) {
      const chunk: [number, number, Buffer][] = [];
      let size = 0;
      while (i < sq.length && (chunk.length === 0 || size + sq[i][2].length < PART_MAX)) { size += sq[i][2].length; chunk.push(sq[i++]); }
      const head = Buffer.alloc(4 + chunk.length * 12);
      head.writeUInt32BE(chunk.length, 0);
      let off = 0;
      chunk.forEach(([x, y, b], j) => { const o = 4 + j * 12; head.writeUInt16BE(x, o); head.writeUInt16BE(y, o + 2); head.writeUInt32BE(off, o + 4); head.writeUInt32BE(b.length, o + 8); off += b.length; });
      recs.push(...rec(blk, part++, exp, Buffer.concat([head, ...chunk.map((c) => c[2])])));
    }
  }
  await send(recs, g);
  pending.delete(g);
}

/** A whole file (chart lines, wind grid) under its own address; kept `hours` hours. */
export async function putFile(Key: string, body: Buffer | string, _hours?: number) {
  await send(rec(Key, 0, Math.floor(Date.now() / 1000) + keepHours(Key) * 3600, Buffer.from(body)), Key);
}
