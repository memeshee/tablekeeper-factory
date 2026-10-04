# Tablekeeper Factory — Dark Factory (WeAreDevelopers) submission

Track: **tablekeeper** — a restaurant reservation system (an OpenTable) where a table
must never be double-booked, under concurrency, retries and time zones.

- Team: kiter (PhiBao, GitHub [@memeshee](https://github.com/memeshee)) plus a band of
  three coding-agent seats — **Architect**, **Builder**, **Checker** — running in
  Band Desktop.
- Submission repo: <https://github.com/memeshee/tablekeeper-factory> (public, clones
  without Band Desktop membership).
- Kickoff package the specs came from:
  <https://github.com/band-ai/dark-factory-wearedevs> (not submitted, just referenced
  by the harness commands below).

The service never double-books: single tables and declared combinable pairs,
policy-driven capacity/hours/terms, recurring series, and manager replans with atomic
closure plus optimal reseating.

## How to read this repository

Per the participant guide, this repo is the entry: one folder per completed stage,
the factory description, the seat mandates, and the Band room export.

- `stage-1/` … `stage-4/` — all four stages, each a **complete, buildable service on
  its own** (Node 18 + TypeScript, `Dockerfile`, `RUN.md`, `src/`, `public/` browser
  UI in stages 2–4). Copy-forward: each stage started as a copy of the previous
  stage's folder and extended it; earlier stages stay frozen.
- `mandates/` — one standing-instruction file per seat (`architect.md`, `builder.md`,
  `checker.md`). Each starts with the seat's `Harness:` and `Model:` lines. Generic
  by rule: no endpoint paths, field names, or error codes — track detail lives only
  in the room tasks.
- `FACTORY.md` — the factory itself: seats, runtime, loop, design choices, measured
  costs, and how bad work gets caught.
- `room.json` — the Band room where this entry was built, as a **Download full
  session** file saved unchanged and renamed: the *"Tablekeeper Build Room"*
  (26 Sep → 3 Oct, 1,477 messages from Architect, Builder, Checker and the human
  dispatcher). This is the file `harness check` validates for gates 1–2.
- `room-factory-run.json` — supplementary: the earlier *"Tablekeeper Factory Run"*
  room (26 Sep, 1,000 messages) where stage 1 was first attempted before the room hit
  the message cap and work continued in the Build Room. Unedited full-session
  download; early stage-1 commits trace to it.
- `room-toy-loop.json` — supplementary: the *"Toy Factory Loop"* practice room
  (26 Sep, 879 messages, zero human input) where the factory rehearsed the whole
  loop on the unscored toy track first.
- `NO-NETWORK-PROOF.md` — clean-container evidence: every stage serves from an
  isolated network with no egress.
- `LICENSE` — MIT.

Why three rooms instead of one: the first Tablekeeper room filled up mid-stage-1
(Band message cap), so the run continued in the Build Room; the toy room is the
rehearsal the guide recommends. `room.json` is the room that produced stages 1–4 as
submitted; the other two are included so every commit in the Git history traces to
the discussion that produced it.

## What each stage implements

| Stage | What the folder holds | Last harness reading during the build |
|---|---|---|
| 1 — JSON API | Auth, restaurants, availability, atomic idempotent bookings, `POST /reservation-moves`, state export/import | 116/120 (4 parked edge cases, see below) |
| 2 — browser UI | Stage 1 carried forward + search and availability grid, booking, confirmation and lookup, stale-state/lost-response recovery, combined-table bookings | 25/25 |
| 3 — state over time | Stage 2 carried forward + effective-dated policies (bookings keep accepted terms), truthful history, recurring series with independent occurrences | 7/7 |
| 4 — bulk change | Stage 3 carried forward + series amendments, bounded deterministic closure-replanning with read-only preview and atomic apply (exhaustive solver: fewest moves, then fewest unused seats, then option rank) | 6/6 |

Stage-1 note: the 4 non-passing checks at the time were parked edge cases —
skipped-hour validation, fall-back dedupe, cross-zone instants, moves batch — not
core flows. Judging runs the full (unshipped) suite, so a green shipped run is
directional, not proof; the folders are built to the spec, not to the tests.

## Reproduce

Prerequisites: a running Docker daemon. No Band membership, no model keys, no
network egress needed — every image builds and serves self-contained.

Quick single stage, Docker only (port 8080, overridable with `PORT`):

```sh
cd stage-4 && docker build -t tk4 . && docker run --rm -p 8080:8080 -e PORT=8080 tk4
curl localhost:8080/health
```

Stages 2–4 also serve the browser UI at `http://localhost:8080`: log in with a
seeded account (see the track spec fixtures), search availability for a party,
click a free slot, confirm, and look the booking up by its reference. One click
books exactly one table at one slot — the slot is gone for everyone else.

Official check, from a checkout of the kickoff package beside this repo:

```sh
cd ~/dark-factory-wearedevs
.venv/bin/python -m harness run --track tablekeeper --repo <this-repo> --stage N
# final, judged-mode per folder:
.venv/bin/python -m harness run --track tablekeeper --repo <this-repo> --all --mode isolated
```

`--stage N` also runs the next suite as the overshoot check (a `stage-3/` that
passes suite 4 claims nothing). Each stage folder documents its own run in its
`RUN.md`. Verified during the build: every stage compiles with 0 TypeScript errors
and serves `/health` from a container with no outbound network
(see `NO-NETWORK-PROOF.md`).

## Gate checklist (participant guide § "Four gates")

1. **Roster** — 3 distinct seats (Architect, Builder, Checker), each with
   `mandates/<seat>.md` naming its harness and model. ✅ `harness check` passes.
2. **Room log** — `room.json` holds 1,477 messages with seats addressing each other
   and replying both directions (heaviest lane: Architect↔Builder). ✅ passes.
3. **Builds and serves** — each `stage-N/` has `Dockerfile` + `RUN.md`, no nested
   `.git`, and serves `/health` from a clean container. ✅ per-folder, see above.
4. **Generic mandates, spec-built code** — mandate vocabulary scan clean. ✅ passes.

`python -m harness check <repo> --track tablekeeper` reports one note: an
`env-assignment`-shaped match inside `room-factory-run.json`. Reviewed line by
line: every match is JavaScript source quoted in tool-call output
(`token = authHeader.substring(7)`, `idempotencyKey = req.headers[…]`), not a
credential. No bearer tokens, no `sk-`/`AKIA`/GitHub tokens, no URL credentials in
any of the three room files. (`room.json` itself is exempt from that scan shape;
the two supplementary rooms are not, hence the note.)

## Design notes

- Timezone-correct throughout: occurrences computed from local wall-clock, never
  UTC-shifted (a UTC-instant bug that shifted series hours was found and fixed
  mid-run via the room).
- Idempotency everywhere (create/amend/cancel/series/replans/apply) with
  exact-replay semantics, including reusing the original `created_at` on replay.
- Replan solver is exhaustive, not greedy: minimizes moved bookings, then unused
  seats, then the option-rank vector — optimal within the planning limits.
- Atomicity: failed amends/replans change nothing (histories, revisions,
  idempotency records untouched).

Costs, failure handling, and what the factory caught are in `FACTORY.md` — that
file plus `mandates/` is written to be enough for another team to stand this
factory up.
