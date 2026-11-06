/**
 * A small GRIB2 reader: one message, regular lat/lon grid (template 3.0),
 * "complex packing with spatial differencing" (template 5.3) or simple
 * packing (5.0), with or without a bitmap. Enough for NOAA's HAFS storm
 * files (see hafs.ts); not a general GRIB2 library.
 *
 * Checked against pygrib/ecCodes on a HAFS-A storm.sat file (27 Sep 2026,
 * Hurricane Polo, simulated GOES band 13): every value identical to 0.01 K.
 */

export interface Grib2Field {
  /** Values row by row, first row = first latitude in the file; NaN = missing. */
  values: Float32Array;
  ni: number;
  nj: number;
  lat1: number;
  lon1: number;
  dLat: number; // signed: + when rows run south -> north
  dLon: number;
}

const u8 = (b: Buffer, o: number) => b[o];
const u16 = (b: Buffer, o: number) => b.readUInt16BE(o);
const u32 = (b: Buffer, o: number) => b.readUInt32BE(o);
/** GRIB2 signed integers are sign-and-magnitude, not two's complement. */
const s16 = (b: Buffer, o: number) => {
  const v = b.readUInt16BE(o);
  return v & 0x8000 ? -(v & 0x7fff) : v;
};
const s32 = (b: Buffer, o: number) => {
  const v = b.readUInt32BE(o);
  return v & 0x80000000 ? -(v & 0x7fffffff) : v;
};
const sN = (b: Buffer, o: number, n: number) => {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + b[o + i];
  const signBit = 2 ** (8 * n - 1);
  return v >= signBit ? -(v - signBit) : v;
};

class Bits {
  private pos: number; // bit position
  constructor(private b: Buffer, byteOffset: number) {
    this.pos = byteOffset * 8;
  }
  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.b[this.pos >> 3];
      v = v * 2 + ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
  align() {
    this.pos = Math.ceil(this.pos / 8) * 8;
  }
}

/** Decodes the first GRIB2 message in `buf` (e.g. a byte range cut with the .idx file). */
export function decodeGrib2(buf: Buffer): Grib2Field {
  if (buf.toString("latin1", 0, 4) !== "GRIB" || buf[7] !== 2) throw new Error("not a GRIB2 message");
  let o = 16;
  let grid: Omit<Grib2Field, "values"> | null = null;
  let drs: Buffer | null = null;
  let tmpl = -1;
  let nValues = 0;
  let bitmap: Buffer | null = null;
  let data: Buffer | null = null;
  while (o < buf.length - 4) {
    if (buf.toString("latin1", o, o + 4) === "7777") break;
    const len = u32(buf, o);
    const num = u8(buf, o + 4);
    const sec = buf.subarray(o, o + len);
    if (num === 3) {
      if (u16(sec, 12) !== 0) throw new Error(`grid template 3.${u16(sec, 12)} not supported`);
      const ni = u32(sec, 30), nj = u32(sec, 34);
      const lat1 = s32(sec, 46) / 1e6, lon1 = u32(sec, 50) / 1e6;
      const lat2 = s32(sec, 55) / 1e6;
      const di = u32(sec, 63) / 1e6, dj = u32(sec, 67) / 1e6;
      const scan = u8(sec, 71);
      if (scan & 0x80) throw new Error("grids scanning east to west are not supported");
      const northward = (scan & 0x40) !== 0 || lat2 > lat1;
      grid = { ni, nj, lat1, lon1: lon1 > 180 ? lon1 - 360 : lon1, dLat: northward ? dj : -dj, dLon: di };
    } else if (num === 5) {
      nValues = u32(sec, 5);
      tmpl = u16(sec, 9);
      drs = sec;
    } else if (num === 6) {
      const ind = u8(sec, 5);
      if (ind === 0) bitmap = sec.subarray(6);
      else if (ind !== 255) throw new Error("predefined bitmaps are not supported");
    } else if (num === 7) {
      data = sec.subarray(5);
    }
    o += len;
  }
  if (!grid || !drs || !data) throw new Error("incomplete GRIB2 message");
  const R = drs.readFloatBE(11);
  const E = s16(drs, 15);
  const D = s16(drs, 17);
  const nbits = u8(drs, 19);
  const scale = (x: number) => (R + x * 2 ** E) / 10 ** D;
  const packed = new Float64Array(nValues);

  if (tmpl === 0) {
    const bits = new Bits(data, 0);
    for (let i = 0; i < nValues; i++) packed[i] = scale(nbits ? bits.read(nbits) : 0);
  } else if (tmpl === 3 || tmpl === 2) {
    const missingMgmt = u8(drs, 22);
    if (missingMgmt !== 0) throw new Error("complex packing with missing-value management is not supported");
    const NG = u32(drs, 31);
    const refW = u8(drs, 35), bitsW = u8(drs, 36);
    const refL = u32(drs, 37), incL = u8(drs, 41), lastL = u32(drs, 42), bitsL = u8(drs, 46);
    const order = tmpl === 3 ? u8(drs, 47) : 0;
    const nOct = tmpl === 3 ? u8(drs, 48) : 0;
    let p = 0;
    const firsts: number[] = [];
    for (let i = 0; i < order; i++, p += nOct) firsts.push(sN(data, p, nOct));
    const gmin = order ? sN(data, p, nOct) : 0;
    p += order ? nOct : 0;
    const bits = new Bits(data, p);
    const refs = new Array<number>(NG);
    for (let g = 0; g < NG; g++) refs[g] = nbits ? bits.read(nbits) : 0;
    bits.align();
    const widths = new Array<number>(NG);
    for (let g = 0; g < NG; g++) widths[g] = refW + (bitsW ? bits.read(bitsW) : 0);
    bits.align();
    const lens = new Array<number>(NG);
    for (let g = 0; g < NG; g++) lens[g] = refL + incL * (bitsL ? bits.read(bitsL) : 0);
    lens[NG - 1] = lastL;
    bits.align();
    let k = 0;
    for (let g = 0; g < NG; g++) {
      const w = widths[g];
      for (let j = 0; j < lens[g] && k < nValues; j++) packed[k++] = refs[g] + (w ? bits.read(w) : 0);
    }
    if (order > 0) {
      for (let i = order; i < nValues; i++) packed[i] += gmin;
      if (order === 1) {
        packed[0] = firsts[0];
        for (let i = 1; i < nValues; i++) packed[i] += packed[i - 1];
      } else if (order === 2) {
        packed[0] = firsts[0];
        packed[1] = firsts[1];
        for (let i = 2; i < nValues; i++) packed[i] += 2 * packed[i - 1] - packed[i - 2];
      } else throw new Error(`spatial differencing order ${order} not supported`);
    }
    for (let i = 0; i < nValues; i++) packed[i] = scale(packed[i]);
  } else {
    throw new Error(`data template 5.${tmpl} not supported`);
  }

  const n = grid.ni * grid.nj;
  const values = new Float32Array(n);
  if (bitmap) {
    let k = 0;
    for (let i = 0; i < n; i++) values[i] = (bitmap[i >> 3] >> (7 - (i & 7))) & 1 ? packed[k++] : NaN;
  } else {
    for (let i = 0; i < n; i++) values[i] = packed[i];
  }
  return { values, ...grid };
}
