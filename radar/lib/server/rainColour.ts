/**
 * Colour scale shared by every satellite-rain source (Tomorrow.io primary,
 * NOAA global blend fallback — see tomorrowRain.ts / globalRain.ts): a
 * Dvorak "BD curve" style enhancement, the classic black/white/red scale
 * used for decades on satellite pictures of hurricanes (NOAA/NESDIS, Dvorak
 * 1984), adapted here to RAIN RATE (mm/h) rather than the original's
 * cloud-top brightness temperature.
 *
 * WHITE MEANS THE WORST — the single most severe band, reserved for the top
 * of the scale only (the most extreme rain of all, e.g. a tropical
 * cyclone's core), never used lower down where it could be misread as
 * mild. Below white the scale runs, light to severe: grey (light–moderate
 * rain) → BLACK (the curve's signature reversal, marking the step up into
 * heavy convective rain) → red (heavy) → white (most extreme). Read a
 * colour from its position in the ordered key on screen, not from the
 * colour alone. This is a different scale from the ground radar's
 * (operaRadar.ts) — satellite and radar do not share one legend here.
 *
 * Stops are (rain rate in mm/h, RGBA). Both consumers interpolate in
 * log10(mm/h) between stops, so the bands read the same width on screen
 * regardless of how skewed real rain rates are (a handful of mm/h vs. a
 * tropical core) — one interpolates locally (globalRain.ts's LUT), the
 * other by asking Tomorrow.io's tile service to do it (tomorrowRain.ts),
 * but both start from these exact same numbers so the two sources are
 * never visibly a different scale.
 */
export const DVORAK_STOPS: [number, [number, number, number, number]][] = [
  [0.2, [85, 88, 92, 140]], // lightest drawn: dark grey
  [0.8, [125, 125, 127, 168]], // grey
  [2.5, [170, 170, 172, 195]], // light grey
  [6, [18, 18, 18, 225]], // BLACK — the curve's signature reversal: the step into heavy convective rain
  [15, [130, 0, 0, 236]], // dark red
  [35, [215, 25, 20, 244]], // red
  [80, [255, 100, 10, 248]], // red-orange
  [180, [255, 255, 255, 255]], // WHITE — reserved for the worst: the most extreme rain rates only
];
/** Lightest rain drawn, mm/h. */
export const MIN_RAIN_MM = DVORAK_STOPS[0][0];

// ---- local LUT (for globalRain.ts, which decodes a raw grid itself) -----------
const LUT_STEPS_PER_DECADE = 200;
const LOG_MIN = Math.log10(DVORAK_STOPS[0][0]);
const LOG_MAX = Math.log10(DVORAK_STOPS[DVORAK_STOPS.length - 1][0]);
const LUT_LEN = Math.round((LOG_MAX - LOG_MIN) * LUT_STEPS_PER_DECADE) + 1;
export const DVORAK_LUT = new Uint8ClampedArray(LUT_LEN * 4);
for (let k = 0; k < LUT_LEN; k++) {
  const logMm = LOG_MIN + (k / (LUT_LEN - 1)) * (LOG_MAX - LOG_MIN);
  let c = DVORAK_STOPS[0][1];
  for (let i = 1; i < DVORAK_STOPS.length; i++) {
    const [aLog, aC] = [Math.log10(DVORAK_STOPS[i - 1][0]), DVORAK_STOPS[i - 1][1]];
    const [bLog, bC] = [Math.log10(DVORAK_STOPS[i][0]), DVORAK_STOPS[i][1]];
    if (logMm <= bLog || i === DVORAK_STOPS.length - 1) {
      const t = Math.max(0, Math.min(1, (logMm - aLog) / (bLog - aLog)));
      c = [0, 1, 2, 3].map((j) => Math.round(aC[j] + (bC[j] - aC[j]) * t)) as [number, number, number, number];
      break;
    }
  }
  DVORAK_LUT.set(c, k * 4);
}
/** mm/h → this scale's LUT index (globalRain.ts tile painter; also the on-screen key). */
export const dvorakLutIndex = (mm: number) => Math.round(((Math.log10(Math.max(MIN_RAIN_MM, mm)) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * (LUT_LEN - 1));

// ---- Tomorrow.io gradient param (asks their tile service to paint the same scale) ---
const hex2 = (n: number) => n.toString(16).padStart(2, "0");
/**
 * Builds Tomorrow.io's `gradient` query-param value from DVORAK_STOPS, so
 * their server paints the SAME colours at the SAME mm/h thresholds rather
 * than our own default (green→yellow→red). Confirmed empirically (24 Sep
 * 2026): `gradient` positions are the field's own value (mm/h for
 * precipitationIntensity, matching their published 0-0.36-2-7-50 mm/h
 * legend), colour is 8-digit hex RGBA. A stop is added at 0.1 mm/h fully
 * transparent so anything drier than our own MIN_RAIN_MM is left unpainted,
 * matching the local renderer's cutoff exactly.
 */
export function tomorrowDvorakGradient(): string {
  const stops = [`${(MIN_RAIN_MM / 2).toFixed(2)}:00000000`, ...DVORAK_STOPS.map(([mm, [r, g, b, a]]) => `${mm}:${hex2(r)}${hex2(g)}${hex2(b)}${hex2(a)}`)];
  return stops.join(",");
}
