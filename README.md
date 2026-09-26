# Tablekeeper Factory — Dark Factory (WeAreDevelopers) entry

Track: **tablekeeper** (restaurant reservation system).
Team: kiter (PhiBao) + a band of three coding-agent seats.

## How to read this repository

- `FACTORY.md` — the factory: seats, design choices, measured costs, failure handling.
- `mandates/` — one file per seat, named after the seat. Each states its harness
  and model and describes how the seat works (generic — no track detail).
- `room.json` — the full Band room download: every message of the submitted run.
- `stage-1/` … `stage-4/` — one complete, buildable service per stage. Each folder
  has a `Dockerfile`, a `RUN.md`, and source. Each folder claims its own stage
  only: `stage-N/` passes suites 1..N and does not pass suite N+1.

## Reproduce

```sh
cd ~/dark-factory-wearedevs
.venv/bin/python -m harness run --track tablekeeper --repo <this-repo> --all --mode isolated
```

Each stage folder also builds and starts by following its own `RUN.md`.
