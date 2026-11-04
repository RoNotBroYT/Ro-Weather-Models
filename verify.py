"""
Check logged forecasts against what the airports reported.

Each blend run logs every model's forecast (and our blend's) for the check
stations to logs/forecasts/<run>.json. Once a day this script takes the last
30 hours of METAR reports, pairs each with every logged forecast for that hour
(the report nearest the hour, within 30 minutes), adds the errors to
logs/errors/<day>.csv, and rebuilds SCORES.md from the last 14 days.
"""

import csv
import datetime as dt
import glob
import json
import os
from collections import defaultdict

import stations

VARS = ("temp", "dew", "wind", "gust", "cloud", "pressure")
UNITS = {"temp": "°C", "dew": "°C", "wind": "m/s", "gust": "m/s", "cloud": "%", "pressure": "hPa"}
BUCKETS = [(0, 24, "day 1"), (24, 72, "days 2-3"), (72, 144, "days 4-6"), (144, 241, "days 7-10")]


def obs_by_hour():
    """(station, valid hour epoch) -> observation, from the report nearest each hour."""
    best = {}
    for m in stations.metars(30):
        t = m.get("obsTime")
        if not m.get("icaoId") or not t:
            continue
        hour = round(t / 3600) * 3600
        gap = abs(t - hour)
        if gap > 1800:
            continue
        key = (m["icaoId"], hour)
        if key not in best or gap < best[key][0]:
            best[key] = (gap, stations.observation(m))
    return {k: v[1] for k, v in best.items()}


def main():
    os.makedirs("logs/errors", exist_ok=True)
    obs = obs_by_hour()
    done = set()
    for p in glob.glob("logs/errors/*.csv"):
        with open(p) as fh:
            done.update((r["station"], r["run"], r["lead"]) for r in csv.DictReader(fh))
    today = dt.datetime.utcnow().strftime("%Y-%m-%d")
    path = f"logs/errors/{today}.csv"
    new = not os.path.exists(path)
    added = 0
    with open(path, "a", newline="") as fh:
        w = csv.writer(fh)
        if new:
            w.writerow(["station", "run", "lead", "valid", "var", "model", "forecast", "observed", "error"])
        for p in sorted(glob.glob("logs/forecasts/*.json")):
            log = json.load(open(p))
            run = dt.datetime.strptime(log["run"], "%Y-%m-%dT%H:00Z").replace(tzinfo=dt.timezone.utc)
            for stn, leads in log["stations"].items():
                for lead, models in leads.items():
                    if (stn, log["run"], lead) in done:
                        continue
                    valid = int(run.timestamp()) + int(lead) * 3600
                    o = obs.get((stn, valid))
                    if not o:
                        continue
                    for model, fc in models.items():
                        for v in VARS:
                            if fc.get(v) is None or o.get(v) is None:
                                continue
                            w.writerow([stn, log["run"], lead, valid, v, model, fc[v], round(o[v], 2), round(fc[v] - o[v], 2)])
                            added += 1
    print("errors added:", added)
    scores()


def scores():
    """SCORES.md: mean absolute error by model, variable and range, last 14 days."""
    since = (dt.datetime.utcnow() - dt.timedelta(days=14)).strftime("%Y-%m-%d")
    err = defaultdict(list)
    for p in sorted(glob.glob("logs/errors/*.csv")):
        if os.path.basename(p)[:10] < since:
            continue
        with open(p) as fh:
            for r in csv.DictReader(fh):
                lead = int(r["lead"])
                b = next((name for lo, hi, name in BUCKETS if lo <= lead < hi), None)
                if b:
                    err[(r["var"], b, r["model"])].append(abs(float(r["error"])))
    models = sorted({k[2] for k in err}, key=lambda m: (m != "blend", m))
    lines = ["# Forecast scores", "", f"Mean absolute error against airport reports, last 14 days (updated {dt.datetime.utcnow():%Y-%m-%d %H:%M} UTC). Lower is better; **bold** = best.", ""]
    for v in VARS:
        lines += [f"## {v} ({UNITS[v]})", "", "| range | " + " | ".join(models) + " | reports |", "|---" * (len(models) + 2) + "|"]
        for _, _, b in BUCKETS:
            vals = {m: err.get((v, b, m)) for m in models}
            maes = {m: sum(x) / len(x) for m, x in vals.items() if x}
            if not maes:
                continue
            top = min(maes.values())
            cells = [(f"**{maes[m]:.2f}**" if maes[m] == top else f"{maes[m]:.2f}") if m in maes else "–" for m in models]
            lines.append(f"| {b} | " + " | ".join(cells) + f" | {max(len(x) for x in vals.values() if x)} |")
        lines.append("")
    open("SCORES.md", "w").write("\n".join(lines))


if __name__ == "__main__":
    main()
