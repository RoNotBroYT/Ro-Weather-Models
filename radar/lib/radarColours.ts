/**
 * The radar's snow and mix colour scales, shared by the server (which draws the
 * tiles) and the browser (which reads a tapped pixel's colour back into dBZ).
 * The rain scale is dbzToRgba in lib/server/operaRadar.ts (no server-only code,
 * so the browser imports it too).
 */
export type Stop = { dbz: number; rgb: [number, number, number] };
// Snow and mix use colours the rain scale never does (it ends in pink/magenta
// for very heavy rain): white and grey for snow, purple for heavy snow and mix.
// Snow: white → light grey → lilac for heavy.
export const SNOW_STOPS: Stop[] = [
  { dbz: 5, rgb: [215, 218, 226] },
  { dbz: 15, rgb: [236, 238, 244] },
  { dbz: 25, rgb: [255, 255, 255] },
  { dbz: 32, rgb: [200, 200, 212] },
  { dbz: 40, rgb: [190, 165, 235] },
  { dbz: 50, rgb: [150, 110, 225] },
];
// Mix / sleet: lavender → deep purple.
export const MIX_STOPS: Stop[] = [
  { dbz: 5, rgb: [205, 190, 240] },
  { dbz: 20, rgb: [175, 145, 232] },
  { dbz: 32, rgb: [140, 100, 215] },
  { dbz: 42, rgb: [110, 65, 190] },
  { dbz: 52, rgb: [80, 35, 150] },
];

export function ramp(stops: Stop[], dbz: number): [number, number, number, number] {
  if (!(dbz >= 5)) return [0, 0, 0, 0];
  const a = Math.round(255 * Math.min(1, (dbz - 5) / 6 + 0.45));
  if (dbz >= stops[stops.length - 1].dbz) return [...stops[stops.length - 1].rgb, a];
  for (let i = 0; i < stops.length - 1; i++) {
    const p = stops[i], q = stops[i + 1];
    if (dbz < q.dbz) {
      const k = Math.max(0, (dbz - p.dbz) / (q.dbz - p.dbz));
      return [
        Math.round(p.rgb[0] + (q.rgb[0] - p.rgb[0]) * k),
        Math.round(p.rgb[1] + (q.rgb[1] - p.rgb[1]) * k),
        Math.round(p.rgb[2] + (q.rgb[2] - p.rgb[2]) * k),
        a,
      ];
    }
  }
  return [0, 0, 0, 0];
}

// Lookup tables in half-dBZ steps from −32 to +95.
const lut = (stops: Stop[]) => {
  const t = new Uint8Array(255 * 4);
  for (let i = 0; i < 255; i++) t.set(ramp(stops, -32 + i / 2), i * 4);
  return t;
};
export const snowLut = () => lut(SNOW_STOPS);
export const mixLut = () => lut(MIX_STOPS);

