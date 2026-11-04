"""
Stations we check the forecast against: airports, because their METAR reports
are free, worldwide and every 30-60 minutes (aviationweather.gov, US public domain).
"""

import json
import time
import urllib.request

STATIONS = [
    # UK and Ireland
    "EGLL", "EGKK", "EGSS", "EGBB", "EGCC", "EGNM", "EGNT", "EGPH", "EGPF", "EGPD",
    "EGGD", "EGFF", "EGHI", "EGAA", "EIDW",
    # Europe
    "LFPG", "EHAM", "EDDF", "EDDM", "LEMD", "LIRF", "LOWW", "EKCH", "ENGM", "ESSA",
    "EFHK", "BIKF", "LPPT", "LGAV", "EPWA",
    # Rest of the world
    "KJFK", "KORD", "KLAX", "KSEA", "CYYZ", "RJTT", "WSSS", "VABB", "YSSY", "FAOR",
    "SBGR", "OMDB", "NZAA", "SCEL", "HKJK",
]

METAR_API = "https://aviationweather.gov/api/data/metar"
UA = {"User-Agent": "ro-weather-models (https://www.ro-weather.app)"}

# METAR cloud amounts in eighths -> percent (middle of each range).
COVER = {"SKC": 0, "CLR": 0, "NCD": 0, "NSC": 0, "CAVOK": 0, "FEW": 19, "SCT": 44, "BKN": 75, "OVC": 100, "OVX": 100}


def metars(hours):
    """Reports for every station over the last `hours` hours (asked in small
    batches: the service times out on long lists over many hours)."""
    out = []
    for k in range(0, len(STATIONS), 8):
        url = f"{METAR_API}?ids={','.join(STATIONS[k:k + 8])}&hours={hours}&format=json"
        for attempt in range(4):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                    out += json.load(r)
                break
            except Exception:  # noqa: BLE001
                if attempt == 3:
                    raise
                time.sleep(5 * (attempt + 1))
    return out


def observation(m):
    """One METAR -> our variables (None where the report does not say)."""
    kt = 0.514444
    clouds = [COVER.get(c.get("cover")) for c in m.get("clouds") or []]
    clouds = [c for c in clouds if c is not None]
    cover = COVER.get(m.get("cover"))
    return {
        "temp": m.get("temp"),
        "dew": m.get("dewp"),
        "wind": m["wspd"] * kt if isinstance(m.get("wspd"), (int, float)) else None,
        "gust": m["wgst"] * kt if isinstance(m.get("wgst"), (int, float)) else None,
        "cloud": max(clouds) if clouds else cover,
        "pressure": m.get("slp") or m.get("altim"),
    }


def positions():
    """ICAO -> (lat, lon), from the latest reports."""
    out = {}
    for m in metars(3):
        if m.get("icaoId") and m.get("lat") is not None:
            out[m["icaoId"]] = (m["lat"], m["lon"])
    return out
