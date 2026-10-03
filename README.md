# Tablekeeper Factory — Dark Factory (WeAreDevs) entry

Track: **tablekeeper** (restaurant reservation system). Team: kiter (PhiBao) + a band of three coding-agent seats (Architect, Builder, Checker) running on BAND Desktop infrastructure.

The service never double-books: single tables and declared combinable pairs, policy-driven pricing/capacity/hours, recurring series, manager replans with atomic closure + optimal reseating.

## Scores (track harness, `dark-factory-wearedevs`)

| Stage | Result | Notes |
|---|---|---|
| 1 — API + policies core | 116/120 | 4 parked edge cases (skipped-hour validation, fall-back dedupe, cross-zone instants, moves batch) |
| 2 — UI + availability | 25/25 | green |
| 3 — policies / history / explain / series | 7/7 | green |
| 4 — revision / pairs / amend / replans | 6/6 | green |

## Repository map

- `stage-1/` … `stage-4/` — one complete, buildable service per stage. Each has `Dockerfile`, `package.json`, `tsconfig.json`, `RUN.md`, `src/`, `public/` (stages 2–4). Copy-forward: each stage starts as a copy of the previous one and extends it; earlier stages stay frozen.
- `mandates/` — one standing-instruction file per seat (`architect.md`, `builder.md`, `checker.md`). Generic by rule: no endpoint paths, field names, or error codes. Track detail lives only in the room tasks.
- `FACTORY.md` — the factory: seats, runtime, loop, cost discipline.
- `room-export.json` — full export of the BAND room that generated this solution (every message).
- `NO-NETWORK-PROOF.md` — clean-container evidence: all stages serve on an isolated network with no egress.
- `LICENSE` — MIT.

## Reproduce

Harness (needs the track repo beside this one):

```sh
cd ~/dark-factory-wearedevs
.venv/bin/python -m harness run --track tablekeeper --repo <this-repo> --stage N
```

Any single stage with Docker only:

```sh
cd stage-4 && docker build -t tk4 . && docker run --rm -p 8080:8080 -e PORT=8080 tk4
```

Each stage folder documents its own run in `RUN.md`. Verified: every stage builds with 0 TypeScript errors and serves `/health` from a container with no outbound network (see `NO-NETWORK-PROOF.md`).

## Design notes

- Timezone-correct throughout: occurrences computed from local wall-clock, never UTC-shifted.
- Idempotency everywhere (create/amend/cancel/series/replans/apply) with exact-replay semantics.
- Replan solver is exhaustive, not greedy: minimizes moved bookings, then unused seats, then the option-rank vector — provably optimal within the planning limits.
- Atomicity: failed amends/replans change nothing (histories, revisions, idempotency untouched).
