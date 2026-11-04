# Ro-Weather models

The forecast behind [Ro-Weather](https://www.ro-weather.app): a blend of free weather models,
rebuilt twice a day by GitHub Actions and stored on Cloudflare R2.

| Model | Detail | Area | Licence |
|---|---|---|---|
| ECMWF IFS (open data) | 0.25° | world | CC BY 4.0, © ECMWF |
| NOAA GFS | 0.25° | world | public domain |
| DWD ICON-EU | 0.0625° | Europe | DWD open data, © Deutscher Wetterdienst |

`blend.py` downloads only the fields it needs (temperature, dew point, wind, gusts, cloud,
pressure, precipitation), puts them on one 0.25° grid every 3 hours out to 10 days, and
blends them with fixed weights (ECMWF 0.5, GFS 0.25, ICON-EU 0.25 over Europe).
`upload.py` sends the result to R2.

Contains modified ECMWF open data (CC BY 4.0), NOAA GFS and DWD ICON-EU data.
