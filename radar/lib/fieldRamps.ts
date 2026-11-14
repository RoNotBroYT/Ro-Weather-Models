/**
 * Colour ramps for gridded weather fields, shared by the server-drawn
 * graphics (lib/server/renderField.ts) and the public Charts page.
 * Plain data + one function: safe to import in the browser.
 */

/** A colour ramp stop, in the parameter's own units. */
export interface Stop {
  v: number;
  rgb: [number, number, number];
}

/**
 * Colour ramps per parameter.
 *
 * Thresholds are in real units and stated once, so a legend generated from
 * this list can never disagree with the pixels — the same rule the radar
 * palettes follow.
 */
export const FIELD_RAMPS: Record<string, Stop[]> = {
  // Each layer has its OWN scale, so a glance tells you which map you are on.
  // Temperature: the classic forecast scale — purple/blue cold, a distinct
  // pale cyan at freezing, green mild, yellow–orange warm, deep red hot.
  temperature: [
    { v: -30, rgb: [120, 40, 150] },
    { v: -20, rgb: [70, 50, 180] },
    { v: -10, rgb: [50, 110, 220] },
    { v: 0, rgb: [140, 215, 240] },
    { v: 5, rgb: [70, 190, 170] },
    { v: 10, rgb: [90, 190, 90] },
    { v: 15, rgb: [180, 210, 70] },
    { v: 20, rgb: [250, 215, 60] },
    { v: 25, rgb: [245, 150, 45] },
    { v: 30, rgb: [225, 70, 45] },
    { v: 40, rgb: [140, 20, 40] },
  ],
  // Rain overview ground tint (°C): muted cool-to-warm, laid under the cloud veil at ~50% opacity.
  overviewTemp: [
    { v: -15, rgb: [120, 90, 190] },
    { v: -5, rgb: [80, 110, 200] },
    { v: 0, rgb: [100, 160, 215] },
    { v: 5, rgb: [80, 175, 185] },
    { v: 10, rgb: [105, 175, 120] },
    { v: 15, rgb: [190, 195, 95] },
    { v: 20, rgb: [235, 190, 80] },
    { v: 28, rgb: [225, 120, 60] },
    { v: 36, rgb: [190, 60, 50] },
  ],
  humidity: [
    { v: 30, rgb: [180, 140, 80] },
    { v: 50, rgb: [190, 190, 140] },
    { v: 70, rgb: [120, 190, 170] },
    { v: 85, rgb: [70, 160, 200] },
    { v: 95, rgb: [50, 110, 190] },
  ],
  // Wind (mph): calm deep blue → breezy teal/green → strong yellow/orange →
  // gale red → storm magenta → hurricane-force near-white.
  wind: [
    { v: 0, rgb: [45, 70, 150] },
    { v: 8, rgb: [45, 140, 190] },
    { v: 16, rgb: [50, 180, 150] },
    { v: 24, rgb: [110, 200, 80] },
    { v: 32, rgb: [240, 215, 60] },
    { v: 40, rgb: [245, 145, 40] },
    { v: 50, rgb: [220, 55, 50] },
    { v: 65, rgb: [175, 35, 130] },
    { v: 80, rgb: [240, 200, 240] },
  ],
  // Gusts (mph): a violet-based scale, distinct from mean wind.
  gusts: [
    { v: 0, rgb: [55, 45, 110] },
    { v: 15, rgb: [80, 90, 190] },
    { v: 30, rgb: [60, 170, 210] },
    { v: 45, rgb: [120, 210, 120] },
    { v: 60, rgb: [250, 205, 60] },
    { v: 75, rgb: [240, 110, 40] },
    { v: 90, rgb: [205, 30, 60] },
    { v: 110, rgb: [250, 210, 250] },
  ],
  // CAPE (J/kg): clear when ~0 (see the layer's fadeIn), then green →
  // yellow → orange → red → magenta → white for the most explosive air.
  // Rain (mm/h): the radar's colours, light blue drizzle → green → yellow → red → magenta.
  rain: [
    { v: 0.05, rgb: [120, 170, 240] },
    { v: 0.5, rgb: [40, 110, 230] },
    { v: 1, rgb: [40, 190, 90] },
    { v: 2, rgb: [240, 220, 50] },
    { v: 4, rgb: [245, 140, 30] },
    { v: 8, rgb: [220, 40, 40] },
    { v: 16, rgb: [200, 40, 200] },
  ],
  // Snow lying (cm): near-white blue for a dusting through blues to deep purples.
  snowdepth: [
    { v: 0.5, rgb: [205, 228, 250] },
    { v: 5, rgb: [150, 190, 245] },
    { v: 10, rgb: [110, 140, 235] },
    { v: 25, rgb: [130, 90, 215] },
    { v: 50, rgb: [150, 50, 190] },
    { v: 100, rgb: [90, 20, 120] },
  ],
  // Winter chart, by precipitation type; stops are the rain rate in mm/h.
  winterRain: [
    { v: 0.05, rgb: [150, 200, 250] },
    { v: 0.5, rgb: [70, 150, 235] },
    { v: 2, rgb: [30, 90, 210] },
    { v: 6, rgb: [20, 40, 150] },
  ],
  winterSnow: [
    { v: 0.05, rgb: [245, 245, 255] },
    { v: 0.5, rgb: [220, 212, 248] },
    { v: 2, rgb: [188, 160, 238] },
    { v: 6, rgb: [145, 95, 215] },
  ],
  winterFrzr: [
    { v: 0.05, rgb: [252, 195, 215] },
    { v: 0.5, rgb: [243, 120, 170] },
    { v: 2, rgb: [220, 45, 130] },
    { v: 6, rgb: [160, 15, 90] },
  ],
  winterSleet: [
    { v: 0.05, rgb: [250, 205, 245] },
    { v: 0.5, rgb: [235, 130, 225] },
    { v: 2, rgb: [195, 55, 195] },
    { v: 6, rgb: [130, 20, 140] },
  ],
  cape: [
    { v: 0, rgb: [40, 120, 80] },
    { v: 250, rgb: [60, 175, 90] },
    { v: 500, rgb: [200, 215, 60] },
    { v: 1000, rgb: [250, 170, 40] },
    { v: 2000, rgb: [230, 60, 45] },
    { v: 3000, rgb: [200, 40, 160] },
    { v: 4500, rgb: [250, 225, 250] },
  ],
  // Shear (kt): slate → cyan → lime → yellow → orange → crimson. Breaks at
  // 20 and 40 kt match the bands the Charts page states.
  shear: [
    { v: 0, rgb: [50, 55, 80] },
    { v: 10, rgb: [70, 100, 170] },
    { v: 20, rgb: [50, 175, 200] },
    { v: 30, rgb: [140, 210, 80] },
    { v: 40, rgb: [250, 210, 50] },
    { v: 55, rgb: [240, 110, 40] },
    { v: 70, rgb: [200, 30, 90] },
  ],
  // Pressure (hPa): deep lows purple/blue, ~1013 green, highs yellow → red.
  pressure: [
    { v: 960, rgb: [110, 40, 160] },
    { v: 975, rgb: [70, 80, 210] },
    { v: 990, rgb: [40, 150, 225] },
    { v: 1005, rgb: [60, 190, 170] },
    { v: 1015, rgb: [110, 200, 90] },
    { v: 1025, rgb: [240, 210, 60] },
    { v: 1035, rgb: [245, 135, 40] },
    { v: 1045, rgb: [210, 45, 55] },
  ],
  // 500 hPa height (dam): the classic upper-air chart scale — deep purple
  // troughs → blue → green → yellow → orange/red ridges.
  z500: [
    { v: 480, rgb: [90, 30, 120] },
    { v: 500, rgb: [60, 60, 190] },
    { v: 516, rgb: [40, 130, 220] },
    { v: 532, rgb: [50, 190, 200] },
    { v: 548, rgb: [90, 195, 100] },
    { v: 560, rgb: [220, 215, 70] },
    { v: 572, rgb: [245, 150, 45] },
    { v: 584, rgb: [215, 55, 45] },
    { v: 596, rgb: [140, 20, 50] },
  ],
  // 850 hPa temperature (°C): diverging, blues below 0, near-white at 0, reds above.
  t850: [
    { v: -28, rgb: [110, 30, 140] },
    { v: -20, rgb: [40, 50, 170] },
    { v: -12, rgb: [40, 110, 220] },
    { v: -4, rgb: [130, 190, 240] },
    { v: 0, rgb: [235, 240, 245] },
    { v: 4, rgb: [250, 210, 140] },
    { v: 12, rgb: [245, 140, 60] },
    { v: 20, rgb: [215, 50, 40] },
    { v: 28, rgb: [130, 15, 40] },
  ],
  // Thickness (dam): blue cold (snow side of 528) → green → yellow/red warm.
  thickness: [
    { v: 504, rgb: [80, 40, 150] },
    { v: 516, rgb: [50, 90, 210] },
    { v: 528, rgb: [120, 200, 240] },
    { v: 540, rgb: [90, 190, 110] },
    { v: 552, rgb: [230, 210, 70] },
    { v: 564, rgb: [240, 130, 45] },
    { v: 576, rgb: [190, 40, 50] },
  ],
};

/** Linear blend between ramp stops. */
export function rampColour(value: number, stops: Stop[]): [number, number, number] {
  if (value <= stops[0].v) return stops[0].rgb;
  const last = stops[stops.length - 1];
  if (value >= last.v) return last.rgb;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (value >= a.v && value <= b.v) {
      const t = (value - a.v) / (b.v - a.v);
      return [
        Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * t),
        Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * t),
        Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * t),
      ];
    }
  }
  return last.rgb;
}

