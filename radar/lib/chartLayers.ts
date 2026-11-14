/**
 * The Charts page's layers, as plain data: label, unit, colour ramp and the
 * definition shown in the page's Definitions panel. One place, so the
 * legend, the tooltip and the definitions can never disagree.
 *
 * Every definition states WHAT the number is and WHEN it applies: each
 * value is the model's value AT the hour on the slider (not a daily
 * average), except gusts, which are the strongest gust expected WITHIN that
 * hour.
 */
import type { GfsLayer as ChartLayerId } from "./server/gfs";

export interface ChartBand {
  range: string;
  meaning: string;
}

export interface ChartLayer {
  id: ChartLayerId;
  label: string;
  short: string;
  unit: string;
  /** Key into FIELD_RAMPS. */
  ramp: string;
  /** Fill opacity, 0–1. Pressure is mostly about the lines, so it is faint. */
  fillAlpha: number;
  /**
   * [from, to]: fill is fully clear below `from`, fading in to full by `to`.
   * For fields where "none" is the usual state (CAPE): a solid dark colour
   * for zero turned the whole map into a grey wash.
   */
  fadeIn?: [number, number];
  /** Contour interval, or 0 for no lines. */
  contourStep: number;
  /** Legend ticks, in the layer's units. */
  ticks: number[];
  definition: string;
  timing: string;
  bands?: ChartBand[];
  /** Internal tile / line source with no chip of its own (drawn inside another chart). */
  hidden?: boolean;
}

export const CHART_LAYERS: ChartLayer[] = [
  {
    id: "pressure",
    label: "Pressure",
    short: "Pressure",
    unit: "hPa",
    ramp: "pressure",
    fillAlpha: 0.72,
    contourStep: 4,
    ticks: [960, 980, 1000, 1020, 1040],
    definition:
      "Mean sea-level pressure: the air pressure, corrected to sea level so hills don't distort it. The lines (isobars) join equal pressure every 4 hPa. Lines packed close together = strong wind. H / L = a pressure centre: the highest / lowest value within 8° (~900 km) that stands at least 5 hPa clear of its surroundings, labelled with its pressure.",
    timing: "Value at the hour shown on the slider.",
  },
  {
    id: "wind",
    label: "Wind",
    short: "Wind",
    unit: "mph",
    ramp: "wind",
    fillAlpha: 0.8,
    contourStep: 0,
    ticks: [0, 10, 20, 30, 40, 50, 65, 80],
    definition:
      "Mean (sustained) wind speed 10 m above the ground. Arrows point the way the wind is blowing TO.",
    timing: "Value at the hour shown on the slider. Gusts are stronger — see the Gusts layer.",
  },
  {
    id: "gusts",
    label: "Gusts",
    short: "Gusts",
    unit: "mph",
    ramp: "gusts",
    fillAlpha: 0.8,
    contourStep: 0,
    ticks: [0, 15, 30, 45, 60, 75, 90, 110],
    definition: "Wind gust speed near the ground: the short bursts (a few seconds) on top of the mean wind.",
    timing: "The model's gust at the hour shown on the slider.",
  },
  {
    id: "rain",
    label: "Rain & overview",
    short: "Rain",
    unit: "mm/h",
    ramp: "rain",
    fillAlpha: 0.85,
    fadeIn: [0.05, 0.3],
    contourStep: 0,
    ticks: [0.1, 0.5, 1, 2, 4, 8, 16],
    definition:
      "An overview in one chart, layered. The ground is tinted by air temperature (2 m), a white veil shows total cloud cover (whiter = cloudier), and the strong colours on top are how hard rain is falling at the hour shown: light blue drizzle through green, yellow and red to magenta downpours. Where the model says snow, it is drawn in white to pale purple instead (freezing rain and sleet in pinks). The thin white lines are sea-level pressure (isobars) with H / L centres. Model forecast, not observed. The further ahead, the more it is a rough guide to wet and dry spells than a timing.",
    timing: "The values at the hour on the slider: every 3 hours to 5 days ahead, then every 6 hours to 16 days (all the layers in this chart, the model has them to 16 days).",
    bands: [
      { range: "under 0.5", meaning: "Drizzle or light showers" },
      { range: "0.5–2", meaning: "Light to moderate rain" },
      { range: "2–8", meaning: "Heavy rain" },
      { range: "over 8", meaning: "Very heavy, torrential in places" },
    ],
  },
  {
    id: "cape",
    label: "CAPE (storm energy)",
    short: "CAPE",
    unit: "J/kg",
    ramp: "cape",
    fillAlpha: 0.8,
    fadeIn: [50, 250],
    contourStep: 0,
    ticks: [0, 500, 1000, 2000, 3000, 4500],
    definition:
      "Convective Available Potential Energy: how much energy a rising pocket of air could gain. More CAPE = stronger updrafts IF storms start. CAPE alone does not make storms: they also need a trigger (heating, a front, hills, sea breeze) and a weak enough 'lid' (CIN).",
    timing: "Value at the hour shown on the slider.",
    bands: [
      { range: "under 100", meaning: "Negligible" },
      { range: "100–500", meaning: "Marginal — showers, the odd rumble of thunder" },
      { range: "500–1,000", meaning: "Moderate — thunderstorms possible" },
      { range: "1,000–2,000", meaning: "High — strong storms possible" },
      { range: "over 2,000", meaning: "Very high (rare in the UK)" },
    ],
  },
  {
    id: "shear",
    label: "Wind shear",
    short: "Shear",
    unit: "kt",
    ramp: "shear",
    fillAlpha: 0.8,
    contourStep: 0,
    ticks: [0, 10, 20, 30, 40, 55, 70],
    definition:
      "Bulk wind shear, in knots: how much the wind changes (speed AND direction) between 10 m above the ground and about 5.5 km up (500 hPa). Shear lets a storm's updraft and downdraft separate, so it lives longer and can organise — and, with enough CAPE, rotate. Shear alone does not make storms: it needs CAPE too.",
    timing: "Value at the hour shown on the slider.",
    bands: [
      { range: "under 20 kt", meaning: "Weak — short-lived single storms" },
      { range: "20–40 kt", meaning: "Moderate — organised clusters and lines" },
      { range: "over 40 kt", meaning: "Strong — long-lived storms; rotating storms possible if CAPE is present" },
    ],
  },
  {
    id: "temperature",
    label: "Temperature",
    short: "Temp",
    unit: "°C",
    ramp: "temperature",
    fillAlpha: 0.8,
    contourStep: 0,
    ticks: [-30, -20, -10, 0, 10, 20, 30, 40],
    definition: "Air temperature 2 m above the ground (standard screen height).",
    timing: "Value at the hour shown on the slider.",
  },
  {
    id: "z500",
    label: "500 hPa height",
    short: "500 hPa",
    unit: "dam",
    ramp: "z500",
    fillAlpha: 0.75,
    contourStep: 6,
    ticks: [492, 516, 540, 564, 588],
    definition:
      "How high you have to climb to reach the 500 hPa pressure level (about halfway up the atmosphere, ~5.5 km), in decametres (1 dam = 10 m). Low heights (blue/purple) = cold air aloft: troughs and upper lows that bring unsettled weather. High heights (orange/red) = warm air aloft: ridges that usually bring settled weather. The dark lines join equal height every 6 dam, and the wind up there blows along them (faster where they are packed together: the jet stream). The white lines are sea-level isobars, as on a forecaster's chart.",
    timing: "Value at the hour shown on the slider.",
    bands: [
      { range: "under 528", meaning: "Deep cold trough — showery, often wintry" },
      { range: "528–564", meaning: "Typical mid-latitude range" },
      { range: "over 576", meaning: "Strong ridge — warm, settled" },
    ],
  },
  {
    id: "t850",
    label: "850 hPa temperature",
    short: "T850",
    unit: "°C",
    ramp: "t850",
    fillAlpha: 0.8,
    contourStep: 4,
    ticks: [-24, -16, -8, 0, 8, 16, 24],
    definition:
      "Air temperature at the 850 hPa level, about 1.5 km up — above the daily heating and cooling at the ground, so it shows the real air mass: where cold and warm air sit and where fronts lie between them. Lines every 4 °C; the 0 °C line is drawn bold. In winter, under about −5 °C at 850 hPa usually means any rain or showers fall as snow down to low levels.",
    timing: "Value at the hour shown on the slider.",
  },
  {
    id: "thickness",
    label: "Thickness (snow guide)",
    short: "Thickness",
    unit: "dam",
    ramp: "thickness",
    fillAlpha: 0.7,
    contourStep: 6,
    ticks: [510, 522, 534, 546, 558, 570],
    definition:
      "1000–500 hPa thickness: the depth of the lower half of the atmosphere, in decametres. Cold air is dense, so the layer is thinner; warm air makes it thicker. The dashed lines join equal thickness every 6 dam. The bold 528 dam line is the classic snow guide: below it, rain and showers are more likely to fall as snow (a rough guide, not a rule — other things matter too). White lines are sea-level isobars.",
    timing: "Value at the hour shown on the slider.",
    bands: [
      { range: "under 522", meaning: "Snow likely if it rains or showers" },
      { range: "522–534", meaning: "Marginal — sleet or snow, especially on hills" },
      { range: "over 540", meaning: "Rain, not snow" },
    ],
  },
  {
    id: "winter",
    label: "Winter overview",
    short: "Winter",
    unit: "mm/h",
    ramp: "winterRain",
    fillAlpha: 0.85,
    fadeIn: [0.05, 0.3],
    contourStep: 6,
    ticks: [0.1, 0.5, 2, 6],
    definition:
      "A winter overview in one chart. The colour fill is the rain or snow the model expects at the hour shown, coloured by what it falls as: rain in blues, snow in white to pale purple, freezing rain and sleet in pinks and magenta (stronger colour = heavier). The dashed lines are 1000–500 hPa thickness every 6 dam: the bold 528 dam line is the classic guide, and where thickness is below it, rain is more likely to fall as snow. The faint white lines are sea-level isobars. Shaded under the precipitation (with purple lines at 1, 5, 10, 25 and 50 cm) is the snow already lying on the ground, from the model. Everything is model forecast, not observed.",
    timing: "Values at the hour on the slider: every 3 hours to 5 days ahead, then every 6 hours to 16 days. The further ahead, the rougher the guide. The type comes from the model's own rain / snow / freezing rain / sleet flags (GFS CRAIN, CSNOW, CFRZR, CICEP); snow depth is the model's snow cover (GFS SNOD), not a measurement.",
    bands: [
      { range: "Rain", meaning: "Blues" },
      { range: "Snow", meaning: "White to pale purple" },
      { range: "Freezing rain", meaning: "Pink to deep rose (ice on the ground; dangerous)" },
      { range: "Sleet", meaning: "Lilac to magenta (ice pellets)" },
    ],
  },
  {
    id: "raincloud",
    label: "Rain with cloud",
    short: "Rain",
    unit: "mm/h",
    ramp: "rain",
    fillAlpha: 0.85,
    fadeIn: [0.05, 0.3],
    contourStep: 0,
    ticks: [0.1, 16],
    definition: "The Rain chart with total cloud cover shaded underneath.",
    timing: "As Rain.",
    hidden: true,
  },
  {
    id: "cloud",
    label: "Cloud cover",
    short: "Cloud",
    unit: "%",
    ramp: "rain",
    fillAlpha: 0.5,
    contourStep: 0,
    ticks: [0, 100],
    definition: "Total cloud cover, from the model.",
    timing: "Value at the hour on the slider.",
    hidden: true,
  },
  {
    id: "winterdepth",
    label: "Winter with snow depth",
    short: "Winter",
    unit: "mm/h",
    ramp: "winterRain",
    fillAlpha: 0.85,
    fadeIn: [0.05, 0.3],
    contourStep: 0,
    ticks: [0.1, 6],
    definition: "The Winter chart with snow depth shaded underneath.",
    timing: "As Winter.",
    hidden: true,
  },
  {
    id: "snowdepth",
    label: "Snow depth",
    short: "Snow",
    unit: "cm",
    ramp: "snowdepth",
    fillAlpha: 0.75,
    fadeIn: [0.3, 1],
    contourStep: 0,
    ticks: [1, 5, 10, 25, 50, 100],
    definition: "How much snow is lying on the ground, from the model; not a measurement. Zero (clear) over most low ground until it snows.",
    timing: "Value at the hour on the slider.",
    hidden: true,
  },
];

export const chartLayerById = (id: string): ChartLayer => CHART_LAYERS.find((l) => l.id === id) ?? CHART_LAYERS[0];

export const CHART_COMMON_NOTES = [
  "Model forecast: NOAA's GFS global model at 0.5° (about 55 km), not observation. Local detail — single showers, sea breezes, hills — is not resolved.",
  "Worldwide, every 3 hours from the model run's start to 120 hours (5 days) ahead. The run used is the newest one fully published; its time is shown under the slider.",
  "Times are UK local time.",
  "Storm-risk areas are a separate, UK-only outlook from the Met Office model (see its own definitions).",
  "Not a warning. Official warnings: Met Office (UK) or your national weather service.",
];
