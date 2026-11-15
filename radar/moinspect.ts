const h5wasm = await import("h5wasm/node");
await h5wasm.ready;
const f = new h5wasm.File("../../mo.h5", "r");
const attrs = (p: string) => { try { const o: any = f.get(p); return Object.fromEntries(Object.entries(o.attrs).map(([k, v]: any) => [k, v.value])); } catch { return null; } };
for (const p of ["what", "where", "how", "dataset1/what", "dataset1/where", "dataset1/data1/what"]) console.log(p, JSON.stringify(attrs(p), (_k, v) => (typeof v === "bigint" ? Number(v) : v)));
const d: any = f.get("dataset1/data1/data");
console.log("data shape", d.shape, d.dtype);
const v = d.value as ArrayLike<number>; let mx = -1e9, mn = 1e9; for (let i = 0; i < v.length; i += 7) { if (v[i] > mx) mx = v[i]; if (v[i] < mn) mn = v[i]; }
console.log("min", mn, "max", mx);
