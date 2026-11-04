"""
Ro-Weather model blend.

Downloads the surface fields we forecast from three free models, puts them on
one 0.25 degree world grid, blends them, and writes one file per run:

    ECMWF IFS open data   0.25 deg, world        CC BY 4.0, (c) ECMWF
    NOAA GFS              0.25 deg, world        public domain
    DWD ICON-EU           0.0625 deg, Europe     DWD open data, (c) DWD

Output (blend.bin): int16, laid out [lat][lon][lead][var], so one place's whole
forecast is a single run of bytes (LEADS * VARS * 2) and a reader needs one
small range request per grid point. meta.json says how to read it.
"""

import bz2
import concurrent.futures as cf
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.request

import eccodes
import numpy as np

import stations

# ---- The grid, the hours and the fields ----

NLAT, NLON = 721, 1440  # 90 .. -90, -180 .. 179.75
LATS = 90 - 0.25 * np.arange(NLAT)
LONS = -180 + 0.25 * np.arange(NLON)
LEADS = list(range(0, 241, 3))  # hours ahead, every 3 h to 10 days

# name, scale (stored = value * scale), offset (stored = (value - offset) * scale)
VARS = [
    ("temp", 100, 0),     # 2 m temperature, C
    ("dew", 100, 0),      # 2 m dew point, C
    ("u", 100, 0),        # 10 m wind towards east, m/s
    ("v", 100, 0),        # 10 m wind towards north, m/s
    ("gust", 100, 0),     # gust, m/s
    ("cloud", 100, 0),    # total cloud, %
    ("pressure", 10, 1000),  # mean sea level pressure, hPa
    ("rain", 100, 0),     # precipitation in the 3 h up to this hour, mm
]
VI = {name: i for i, (name, _, _) in enumerate(VARS)}

# How much each model counts. Fixed for now, from published verification
# (ECMWF leads at every range); later replaced by our own station scores.
WEIGHTS = {"ecmwf": 0.5, "gfs": 0.25, "icon": 0.25}

UA = {"User-Agent": "ro-weather-models (https://www.ro-weather.app)"}


def get(url, rng=None, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=dict(UA, **({"Range": f"bytes={rng[0]}-{rng[1]}"} if rng else {})))
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            if getattr(e, "code", None) == 404 or i == tries - 1:
                raise
            time.sleep(2 * (i + 1))


def exists(url):
    try:
        req = urllib.request.Request(url, headers=UA, method="HEAD")
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status == 200
    except Exception:  # noqa: BLE001
        return False


def decode(msg):
    """One GRIB message -> (values on a regular lat/lon grid, lat0, lon0, dlat, dlon)."""
    h = eccodes.codes_new_from_message(msg)
    try:
        ni, nj = eccodes.codes_get(h, "Ni"), eccodes.codes_get(h, "Nj")
        la0 = eccodes.codes_get(h, "latitudeOfFirstGridPointInDegrees")
        lo0 = eccodes.codes_get(h, "longitudeOfFirstGridPointInDegrees")
        la1 = eccodes.codes_get(h, "latitudeOfLastGridPointInDegrees")
        lo1 = eccodes.codes_get(h, "longitudeOfLastGridPointInDegrees")
        vals = eccodes.codes_get_values(h).reshape(nj, ni)
        miss = eccodes.codes_get(h, "missingValue")
        vals = np.where(vals == miss, np.nan, vals)
    finally:
        eccodes.codes_release(h)
    if lo1 < lo0:
        lo1 += 360
    return vals, la0, lo0, (la1 - la0) / (nj - 1), (lo1 - lo0) / (ni - 1)


def to_world(vals, la0, lo0, dla, dlo):
    """Put a field on the 0.25 deg world grid (NaN outside a regional model)."""
    out = np.full((NLAT, NLON), np.nan, dtype=np.float32)
    if abs(dla) == 0.25 and abs(dlo) == 0.25 and vals.shape == (NLAT, NLON):
        v = vals if dla < 0 else vals[::-1]
        shift = int(round(((lo0 + 180) % 360) / 0.25))
        return np.roll(v, shift, axis=1).astype(np.float32)
    # Regional (ICON-EU): nearest source cell for each world point inside it.
    nj, ni = vals.shape
    jj = np.rint((LATS - la0) / dla).astype(int)
    ii = np.rint(((LONS - lo0) % 360) / dlo).astype(int)
    jok, iok = (jj >= 0) & (jj < nj), (ii >= 0) & (ii < ni)
    out[np.ix_(jok, iok)] = vals[np.ix_(jj[jok], ii[iok])]
    return out


# ---- ECMWF IFS open data ----

def ecmwf_run():
    now = dt.datetime.utcnow()
    for back in range(0, 72, 12):
        t = now - dt.timedelta(hours=back)
        run = t.replace(hour=12 if t.hour >= 12 else 0, minute=0, second=0, microsecond=0)
        if exists(ecmwf_url(run, 240, "index")):
            return run
    raise RuntimeError("no complete ECMWF run")


def ecmwf_url(run, step, ext):
    d, h = run.strftime("%Y%m%d"), run.strftime("%H")
    return f"https://data.ecmwf.int/forecasts/{d}/{h}z/ifs/0p25/oper/{d}{h}0000-{step}h-oper-fc.{ext}"


EC_PARAMS = {"2t": "temp", "2d": "dew", "10u": "u", "10v": "v", "10fg": "gust", "tcc": "cloud", "msl": "pressure", "tp": "tp"}


def ecmwf_step(run, step):
    idx = [json.loads(l) for l in get(ecmwf_url(run, step, "index")).decode().splitlines() if l.strip()]
    out = {}
    for e in idx:
        name = EC_PARAMS.get(e.get("param"))
        if not name or e.get("levtype") != "sfc":
            continue
        msg = get(ecmwf_url(run, step, "grib2"), (e["_offset"], e["_offset"] + e["_length"] - 1))
        out[name] = to_world(*decode(msg))
    return out


# ---- NOAA GFS ----

GFS_BASE = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
GFS_FIELDS = [
    ("temp", r":TMP:2 m above ground:"), ("dew", r":DPT:2 m above ground:"),
    ("u", r":UGRD:10 m above ground:"), ("v", r":VGRD:10 m above ground:"),
    ("gust", r":GUST:surface:"), ("cloud", r":TCDC:entire atmosphere:\d+ hour fcst:"),
    ("pressure", r":PRMSL:mean sea level:"), ("tp", r":APCP:surface:0-"),
]


def gfs_url(run, step, ext=""):
    d, h = run.strftime("%Y%m%d"), run.strftime("%H")
    return f"{GFS_BASE}/gfs.{d}/{h}/atmos/gfs.t{h}z.pgrb2.0p25.f{step:03d}{ext}"


def gfs_run():
    now = dt.datetime.utcnow()
    for back in range(0, 48, 6):
        t = now - dt.timedelta(hours=back)
        run = t.replace(hour=t.hour // 6 * 6, minute=0, second=0, microsecond=0)
        if exists(gfs_url(run, 240, ".idx")):
            return run
    raise RuntimeError("no complete GFS run")


def gfs_step(run, step):
    lines = get(gfs_url(run, step, ".idx")).decode().splitlines()
    offs = [int(l.split(":")[1]) for l in lines]
    out = {}
    for name, pat in GFS_FIELDS:
        for k, l in enumerate(lines):
            if re.search(pat, l):
                end = offs[k + 1] - 1 if k + 1 < len(offs) else ""
                out[name] = to_world(*decode(get(gfs_url(run, step), (offs[k], end))))
                break
    return out


# ---- DWD ICON-EU ----

ICON_BASE = "https://opendata.dwd.de/weather/nwp/icon-eu/grib"
ICON_FIELDS = {"temp": "t_2m", "dew": "td_2m", "u": "u_10m", "v": "v_10m", "gust": "vmax_10m", "cloud": "clct", "pressure": "pmsl", "tp": "tot_prec"}


def icon_url(run, step, var):
    h = run.strftime("%H")
    return f"{ICON_BASE}/{h}/{var}/icon-eu_europe_regular-lat-lon_single-level_{run:%Y%m%d%H}_{step:03d}_{var.upper()}.grib2.bz2"


def icon_run():
    now = dt.datetime.utcnow()
    for back in range(0, 24, 6):
        t = now - dt.timedelta(hours=back)
        run = t.replace(hour=t.hour // 6 * 6, minute=0, second=0, microsecond=0)
        if exists(icon_url(run, 120, "t_2m")):
            return run
    return None  # DWD only keeps a day: Europe then runs on two models


def icon_step(run, step):
    out = {}
    for name, var in ICON_FIELDS.items():
        try:
            out[name] = to_world(*decode(bz2.decompress(get(icon_url(run, step, var)))))
        except Exception:  # noqa: BLE001
            pass
    return out


# ---- Blend ----

def fields_at(fetch, run, valid_hours, avail):
    """A model's fields at each wanted hour (since its own run). Hours it does not
    publish are interpolated in time from the two nearest steps (exact for the
    running precipitation total). Only the steps actually needed are downloaded."""
    need = set()
    for h in valid_hours:
        if h in avail:
            need.add(h)
            continue
        lo = max((s for s in avail if s < h), default=None)
        hi = min((s for s in avail if s > h), default=None)
        if lo is not None and hi is not None:
            need.update((lo, hi))
    need = sorted(need)
    with cf.ThreadPoolExecutor(8) as ex:
        got = dict(zip(need, ex.map(lambda s: safe(fetch, run, s), need)))
    got = {s: f for s, f in got.items() if f}
    steps = sorted(got)
    out = {}
    for h in valid_hours:
        if h in got:
            out[h] = got[h]
            continue
        lo = max((s for s in steps if s < h), default=None)
        hi = min((s for s in steps if s > h), default=None)
        if lo is None or hi is None:
            continue
        w = (h - lo) / (hi - lo)
        out[h] = {k: got[lo][k] * (1 - w) + got[hi][k] * w for k in got[lo] if k in got[hi]}
    return out


def safe(fetch, run, s):
    try:
        return fetch(run, s)
    except Exception as e:  # noqa: BLE001
        print(f"  skip {fetch.__name__} step {s}: {e}", file=sys.stderr)
        return None


# Rain and cloud are not averaged plainly: an average spreads light rain and
# half cloud over every place any one model had it, and loses the downpours.
# The blend keeps WHERE the average puts them but takes HOW MUCH from the
# models' own values ("probability-matched mean"), done in 30 deg squares so
# tropical showers and polar drizzle are matched separately.
PM_VARS = ("rain", "cloud")
PM_TILE = 120  # grid points = 30 deg


def matched_blend(mean, parts):
    out = mean.copy()
    # Which models cover each point (ICON-EU only covers Europe).
    key = np.zeros(mean.shape, np.int16)
    for k, (_, a) in enumerate(parts):
        key |= np.isfinite(a).astype(np.int16) << k
    for j0 in range(0, NLAT, PM_TILE):
        for i0 in range(0, NLON, PM_TILE):
            win = (slice(j0, j0 + PM_TILE), slice(i0, i0 + PM_TILE))
            kt, mt = key[win], mean[win]
            ot = out[win]
            for g in np.unique(kt):
                members = [(w, a[win][kt == g]) for k, (w, a) in enumerate(parts) if g >> k & 1]
                if len(members) < 2:
                    continue
                sel = kt == g
                wsum = sum(w for w, _ in members)
                # The weighted average of the models' sorted values: their typical
                # amounts, highest to lowest, placed onto the average's ranking.
                target = sum(w * np.sort(v) for w, v in members) / wsum
                order = np.argsort(mt[sel], kind="stable")
                vals = np.empty_like(target)
                vals[order] = target
                ot[sel] = vals
    return out


def to_units(name, a, model):
    if name in ("temp", "dew"):
        return a - 273.15
    if name == "pressure":
        return a / 100
    if name == "cloud" and model == "ecmwf" and np.nanmax(a) <= 1.01:
        return a * 100
    return a


STATION_VARS = ("temp", "dew", "wind", "gust", "cloud", "pressure")


def at_station(fields, model, j, i):
    """One model's values at a station's grid point (for the forecast log)."""
    out = {}
    for name in STATION_VARS:
        if name == "wind":
            if "u" in fields and "v" in fields:
                out[name] = float(np.hypot(fields["u"][j, i], fields["v"][j, i]))
            continue
        if name in fields:
            out[name] = float(to_units(name, fields[name][j:j + 1, i:i + 1], model)[0, 0])
    return {k: round(v, 2) for k, v in out.items() if np.isfinite(v)}


def main(out_dir="out"):
    os.makedirs(out_dir, exist_ok=True)
    # Where the check stations are, so each model's forecast for them is logged.
    try:
        spots = {k: (int(round((90 - la) / 0.25)), int(round(((lo + 180) % 360) / 0.25)) % NLON) for k, (la, lo) in stations.positions().items()}
    except Exception as e:  # noqa: BLE001
        print("  no station list:", e, file=sys.stderr)
        spots = {}
    log = {k: {} for k in spots}
    runs = {"ecmwf": ecmwf_run(), "gfs": gfs_run(), "icon": icon_run()}
    base = runs["ecmwf"]  # hour 0 of the blend = the ECMWF run time
    print("runs:", {k: v and v.isoformat() for k, v in runs.items()})

    plan = {
        "ecmwf": (ecmwf_step, list(range(0, 145, 3)) + list(range(150, 241, 6))),
        "gfs": (gfs_step, list(range(0, 121, 1)) + list(range(123, 385, 3))),
        "icon": (icon_step, list(range(0, 79, 1)) + list(range(81, 121, 3))),
    }
    # Each model on the blend's clock: model m's step s is valid at blend hour
    # s + off, where off = its run time minus the ECMWF run time.
    offs = {m: int((runs[m] - base).total_seconds() // 3600) for m in plan if runs[m]}
    data = np.zeros((NLAT, NLON, len(LEADS), len(VARS)), dtype=np.int16)
    # A few hours at a time, so only those hours' world fields are in memory.
    CHUNK = 8
    for c0 in range(0, len(LEADS), CHUNK):
        leads = LEADS[c0:c0 + CHUNK]
        per_model = {}
        for m, off in offs.items():
            fetch, avail = plan[m]
            hours = sorted({x for h in leads for x in (h - off, h - off - 3) if x >= 0})
            t0 = time.time()
            per_model[m] = fields_at(fetch, runs[m], hours, avail)
            print(f"  hours {leads[0]}-{leads[-1]} {m}: {len(per_model[m])} fields in {time.time() - t0:.0f} s", flush=True)
        for h in leads:
            for m, f in per_model.items():
                cur = f.get(h - offs[m])
                if cur:
                    for k, (j, i) in spots.items():
                        log[k].setdefault(str(h), {})[m] = at_station(cur, m, j, i)
        for li0, h in enumerate(leads):
            li = c0 + li0
            acc = {name: np.zeros((NLAT, NLON), np.float32) for name, _, _ in VARS}
            parts = {name: [] for name in PM_VARS}  # each model's field, for the matched blend
            wsum = {name: np.zeros((NLAT, NLON), np.float32) for name, _, _ in VARS}
            for m, f in per_model.items():
                off = offs[m]
                cur, prev = f.get(h - off), f.get(h - off - 3)
                if not cur:
                    continue
                for name, _, _ in VARS:
                    if name == "rain":
                        if "tp" not in cur or prev is None or "tp" not in prev:
                            continue
                        k = 1000 if m == "ecmwf" else 1  # ECMWF totals are in metres
                        a = np.clip((cur["tp"] - prev["tp"]) * k, 0, None)
                    else:
                        if name not in cur:
                            continue
                        a = to_units(name, cur[name], m)
                    ok = np.isfinite(a)
                    if name in PM_VARS:
                        parts[name].append((WEIGHTS[m], a))
                    acc[name][ok] += WEIGHTS[m] * a[ok]
                    wsum[name][ok] += WEIGHTS[m]
            for name, scale, offset in VARS:
                with np.errstate(invalid="ignore", divide="ignore"):
                    v = acc[name] / wsum[name]
                if name in PM_VARS and len(parts[name]) > 1:
                    v = matched_blend(v, parts[name])
                v = np.where(wsum[name] > 0, (v - offset) * scale, -32768)
                data[:, :, li, VI[name]] = np.clip(np.rint(v), -32768, 32767).astype(np.int16)
        del per_model

    data.tofile(os.path.join(out_dir, "blend.bin"))
    # Our blend's own values at the stations, next to each model's.
    for k, (j, i) in spots.items():
        for li, h in enumerate(LEADS):
            row = data[j, i, li]
            if row[VI["temp"]] == -32768:
                continue
            val = lambda n: (row[VI[n]] / VARS[VI[n]][1]) + VARS[VI[n]][2]  # noqa: E731
            b = {n: round(float(val(n)), 2) for n in ("temp", "dew", "gust", "cloud", "pressure")}
            b["wind"] = round(float(np.hypot(val("u"), val("v"))), 2)
            log[k].setdefault(str(h), {})["blend"] = b
    with open(os.path.join(out_dir, "stations.json"), "w") as fh:
        json.dump({"run": base.strftime("%Y-%m-%dT%H:00Z"), "stations": log}, fh, separators=(",", ":"))
    meta = {
        "run": base.strftime("%Y-%m-%dT%H:00Z"),
        "made": dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%MZ"),
        "models": {m: runs[m].strftime("%Y-%m-%dT%H:00Z") for m in offs},
        "weights": {m: WEIGHTS[m] for m in offs},
        "grid": {"lat0": 90, "lon0": -180, "step": 0.25, "nlat": NLAT, "nlon": NLON},
        "leads": LEADS,
        "vars": [{"name": n, "scale": s, "offset": o} for n, s, o in VARS],
        "missing": -32768,
        "layout": "int16 little-endian [lat][lon][lead][var]",
        "credit": "Contains modified ECMWF open data (CC BY 4.0), NOAA GFS and DWD ICON-EU data.",
    }
    with open(os.path.join(out_dir, "meta.json"), "w") as fh:
        json.dump(meta, fh, indent=1)
    print("done:", meta["run"])


if __name__ == "__main__":
    main(*sys.argv[1:])
