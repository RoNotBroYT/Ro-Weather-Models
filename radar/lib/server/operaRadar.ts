/**
 * EUMETNET OPERA radar — the European weather services' shared composite.
 *
 * WHY THIS EXISTS ALONGSIDE RAINVIEWER
 *
 * RainViewer's terms permit personal and educational use only, which does
 * not cover a public site with apps and a download page. OPERA is CC BY 4.0
 * — commercial use is fine with attribution, and unlike the Met Office's
 * open radar there is no share-alike clause to propagate into whatever we
 * draw with it.
 *
 * It is also better data, not merely better licensed:
 *
 *   update     5 minutes, against RainViewer's 10
 *   latency    ~7 minutes (measured: the 08:55 file was live at 09:02)
 *   grid       1 km, on a real projected grid
 *   values     actual dBZ as floating point
 *
 * That last line is the one that matters most. RainViewer gives coloured
 * PNG tiles, so every reading we take is recovered by guessing which colour
 * bucket a pixel fell into — a picture made for human eyes, read backwards.
 * OPERA gives the measurement. Storm detection, the 3D height surface and
 * every dBZ we print stop being inferences from an image.
 *
 * WHAT IT IS NOT
 *
 * A 2D composite: the maximum reflectivity in the column above each point.
 * There is no vertical structure here, so it cannot show echo tops, an
 * anvil, or the inside of a storm. Single-site VOLUME data does exist on
 * this feed for about twenty countries, but the UK publishes none of it.
 *
 * ATTRIBUTION IS A LICENCE CONDITION, NOT A COURTESY. CC BY 4.0 requires
 * credit wherever the imagery appears. See ATTRIBUTION below; any UI or
 * rendered frame showing this data must display it.
 */

/** Required by CC BY 4.0 wherever this imagery is shown. */
export const ATTRIBUTION = "Radar © EUMETNET OPERA (CC BY 4.0)";

/**
 * Public S3, no key and no signing.
 *
 * The bucket holds a 24-hour rolling window; there is no archive yet, so
 * anything older than a day is simply gone.
 */
const S3_BASE = "https://s3.waw3-1.cloudferro.com/openradar-24h";

/** OPERA publishes a composite every 5 minutes. */
export const FRAME_INTERVAL_MIN = 5;

/**
 * How far back to offer frames.
 *
 * Two hours matches what RainViewer retains, so the radar page's timeline
 * behaves the same whichever source is selected.
 */
export const HISTORY_MIN = 120;

/**
 * Publication lag. Measured, not assumed: the 08:55Z composite was
 * available at 09:02Z. Seven minutes plus a margin, because asking for a
 * frame that does not exist yet costs a failed request.
 */
const LATENCY_MIN = 10;

export interface OperaFrame {
  /** ms epoch, the composite's validity time. */
  time: number;
  /** Full object URL of the ODIM HDF5 file. */
  url: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Object key for a validity time, e.g. 2026/09/20/OPERA/COMP/OPERA@...DBZH.h5 */
function keyFor(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = pad(d.getUTCMonth() + 1);
  const da = pad(d.getUTCDate());
  const stamp = `${y}${mo}${da}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
  return `${y}/${mo}/${da}/OPERA/COMP/OPERA@${stamp}@0@DBZH.h5`;
}

/**
 * The frames that should exist right now, newest last.
 *
 * Derived from the clock rather than by listing the bucket. A listing is an
 * extra round trip on every request and can itself be stale; the schedule
 * is fixed and published, so the times are predictable. A frame that turns
 * out not to exist fails its own fetch and is skipped, which is the same
 * outcome as never having listed it.
 */
export function recentFrames(now: number = Date.now()): OperaFrame[] {
  const step = FRAME_INTERVAL_MIN * 60 * 1000;
  // Floor to the frame boundary, then step back past the publication lag.
  const latest = Math.floor((now - LATENCY_MIN * 60 * 1000) / step) * step;
  const count = Math.floor(HISTORY_MIN / FRAME_INTERVAL_MIN);
  const out: OperaFrame[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const t = latest - i * step;
    out.push({ time: t, url: `${S3_BASE}/${keyFor(new Date(t))}` });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Projection                                                          */
/* ------------------------------------------------------------------ */

/**
 * OPERA's grid is Lambert Azimuthal Equal Area, the projection named in
 * every file's `where/projdef`:
 *
 *   +proj=laea +lat_0=55 +lon_0=10 +x_0=1950000 +y_0=-2100000
 *   +units=m +ellps=WGS84
 *
 * Equal-area, so a pixel covers the same ground everywhere — which is why
 * it is used for a continental composite, and why it cannot be treated as
 * a plain lat/lon rectangle. The constants are read from each file rather
 * than hard-coded here; these are only the fallbacks, and a mismatch would
 * put the rain in the wrong country.
 */
export interface LaeaGrid {
  lat0: number;
  lon0: number;
  falseEasting: number;
  falseNorthing: number;
  /** Metres per pixel, x and y. */
  xscale: number;
  yscale: number;
  cols: number;
  rows: number;
  /** Projected coordinates of the grid's upper-left CORNER. */
  originX: number;
  originY: number;
}

/**
 * WGS84, the ellipsoid OPERA's projdef names.
 *
 * The projection below is the ELLIPSOIDAL Lambert Azimuthal Equal Area, not
 * the spherical form. That distinction is not academic and was not obvious:
 * the spherical version was written first, and the grid check caught it
 * reproducing the file's own stated corners 12.2km out. No sphere fixes it
 * — the semi-major radius gives 12.2km and the authalic radius 16.5km,
 * because the error is the ellipsoid's shape, not its size.
 *
 * Snyder's oblique ellipsoidal form reproduces all four corners to less
 * than a millimetre. Had the check not been there, every storm would have
 * been drawn about twelve kilometres from where it actually was — a error
 * far too small to look wrong on a map of Europe and far too large to be
 * acceptable on a radar.
 */
const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = 2 * F - F * F;
const E = Math.sqrt(E2);
const DEG = Math.PI / 180;

/**
 * Snyder's `q`: the authalic ("equal-area") measure of a latitude. Equal
 * area is the whole point of this projection, and q is how that is
 * expressed on an ellipsoid.
 */
function authalicQ(phi: number): number {
  const s = Math.sin(phi);
  return (1 - E2) * (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)));
}

const QP = authalicQ(Math.PI / 2);
/** Radius of the sphere with the same surface area as the ellipsoid. */
const RQ = A * Math.sqrt(QP / 2);

/**
 * Forward oblique ellipsoidal LAEA (Snyder, Map Projections — A Working
 * Manual, pp. 187-190).
 *
 * Verified against the corner coordinates OPERA states in every file:
 * agreement to under a millimetre at all four, checked on each decode.
 */
export function lonLatToLaea(lon: number, lat: number, g: LaeaGrid): { x: number; y: number } {
  const phi = lat * DEG;
  const lam = (lon - g.lon0) * DEG;
  const phi1 = g.lat0 * DEG;

  const beta = Math.asin(authalicQ(phi) / QP);
  const beta1 = Math.asin(authalicQ(phi1) / QP);
  const m1 = Math.cos(phi1) / Math.sqrt(1 - E2 * Math.sin(phi1) ** 2);
  const D = (A * m1) / (RQ * Math.cos(beta1));

  const denom =
    1 + Math.sin(beta1) * Math.sin(beta) + Math.cos(beta1) * Math.cos(beta) * Math.cos(lam);
  // Zero only at the point antipodal to the projection centre, in the South
  // Pacific. Guarded so a bad input cannot produce Infinity and paint a
  // stripe across the map.
  if (denom <= 1e-9) return { x: NaN, y: NaN };
  const B = RQ * Math.sqrt(2 / denom);

  return {
    x: B * D * Math.cos(beta) * Math.sin(lam) + g.falseEasting,
    y:
      (B / D) * (Math.cos(beta1) * Math.sin(beta) - Math.sin(beta1) * Math.cos(beta) * Math.cos(lam)) +
      g.falseNorthing,
  };
}

/** Grid column/row (fractional) for a lon/lat. Row 0 is the NORTH edge. */
export function lonLatToGrid(lon: number, lat: number, g: LaeaGrid): { col: number; row: number } {
  const { x, y } = lonLatToLaea(lon, lat, g);
  return {
    col: (x - g.originX) / g.xscale,
    // y increases northward in the projection, rows increase southward.
    row: (g.originY - y) / g.yscale,
  };
}

/* ------------------------------------------------------------------ */
/* Palette                                                             */
/* ------------------------------------------------------------------ */

/**
 * RainViewer's "Universal Blue" ramp, rebuilt from dBZ.
 *
 * Deliberately matched to the existing look rather than invented: switching
 * source should change the data, not how the map reads. The stops are the
 * same colours the RainViewer tiles use, which is why the legend on the
 * radar page stays correct for both.
 *
 * Calibrated for UK rainfall. British rain rarely exceeds 4 mm/hr, so a
 * ramp tuned for continental convection would render almost every UK event
 * as flat blue-green — a mistake already made and corrected once on the
 * classic palette. The amber/red band therefore starts lower than a
 * textbook scale would suggest.
 */
const STOPS: { dbz: number; rgb: [number, number, number] }[] = [
  { dbz: 5, rgb: [136, 221, 238] },
  { dbz: 15, rgb: [0, 163, 224] },
  { dbz: 23, rgb: [0, 119, 170] },
  { dbz: 30, rgb: [0, 85, 136] },
  { dbz: 34, rgb: [0, 71, 104] },
  { dbz: 35, rgb: [255, 238, 0] },
  { dbz: 40, rgb: [255, 170, 0] },
  { dbz: 45, rgb: [255, 68, 0] },
  { dbz: 50, rgb: [193, 0, 0] },
  { dbz: 54, rgb: [93, 0, 0] },
  { dbz: 55, rgb: [255, 170, 255] },
  { dbz: 60, rgb: [255, 119, 255] },
  { dbz: 65, rgb: [255, 255, 255] },
];

/**
 * Below this, nothing is drawn.
 *
 * Not an aesthetic threshold: OPERA reports very low reflectivity over wide
 * areas where nothing is reaching the ground, and painting it would show
 * rain where there is none.
 */
export const MIN_DRAWN_DBZ = 5;

/** Colour for a dBZ value, interpolated between stops. */
export function dbzToRgba(dbz: number): [number, number, number, number] {
  if (!Number.isFinite(dbz) || dbz < MIN_DRAWN_DBZ) return [0, 0, 0, 0];
  if (dbz >= STOPS[STOPS.length - 1].dbz) {
    const c = STOPS[STOPS.length - 1].rgb;
    return [c[0], c[1], c[2], 255];
  }
  for (let i = 0; i < STOPS.length - 1; i++) {
    const a = STOPS[i];
    const b = STOPS[i + 1];
    if (dbz >= a.dbz && dbz < b.dbz) {
      const t = (dbz - a.dbz) / (b.dbz - a.dbz);
      return [
        Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * t),
        Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * t),
        Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * t),
        // Fade the lightest returns in, so drizzle does not read as a hard
        // edge against clear air.
        Math.round(255 * Math.min(1, (dbz - MIN_DRAWN_DBZ) / 6 + 0.35)),
      ];
    }
  }
  return [0, 0, 0, 0];
}
