# The measurement rig of the lpw-26 design record

Not for merge. These are the scripts behind `docs/refactors/idle-tick.md`, kept on this branch so
the measurements can be repeated. They expect a sandbox directory whose path is written to
`/tmp/lpw26-sandbox-path`, holding `scripts/` (this directory), `mods/<variant>.wasm` (the module
of each prototype, built by `build.sh`), `bin/mr_load_driver` and `run/` (one directory per host).

| Script | What it does |
| --- | --- |
| `host.sh` | Starts one `spacetimedb-standalone` 2.16.1 in a systemd scope of 2 GiB, pinned to one core's two threads, on a fresh data directory, and publishes a module. |
| `cell.sh`, `batch.sh` | One measured cell (variant, condition, zone), and up to ten at once. |
| `sample.py` | The sampler: data-directory sizes, memory, processor time and `/v1/metrics`, every 5 seconds. |
| `clogstat.py` | Reads the commit log record by record: transactions and bytes per reducer. |
| `aggregate.py`, `tables.py` | The 30-cell table. |
| `bot.mjs` | The scripted client: standing, walking as the game client sends, watching, pressing; the fault and the dropped socket. |
| `timing.sh`, `timing_stats.py`, `timing_tables.py`, `spread.py` | The step-timing probes and their tables. |
| `fault.sh`, `reconnect.sh` | The failed-tick and the reconnect scenarios. |
| `patch_*.py`, `build.sh` | How each prototype branch was made from `26e1e085`, and how its module was built. |
| `evprobe/` | The one-file module that answers the event-table question (`evsub.mjs` subscribes to it). |
