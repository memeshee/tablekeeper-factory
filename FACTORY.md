# Tablekeeper Factory — how this entry was built

3-seat Band agent factory: **Architect** (plans, splits work, reviews),
**Builder** (implements in the workspace, commits, runs its own checks),
**Checker** (independent verify: clean build + suite + PASS/FAIL per revision).

## Runtime

- Seats are tool-backed: local `opencode serve` + one runner per seat
  (`band-factory/agents/run_opencode.py`), each with the shared workspace as
  its working directory. Chat-only seats were rejected: they claim completion
  with nothing committed.
- Models: Qwen coder-class via OpenAI-compatible APIs (Featherless, then
  Nebius Token Factory `Qwen/Qwen3.8-27B`). Provider is infra only; the judged
  artifact is this repo plus the room log.
- Keep-alive: `band-watchdog.sh` (cron every 15 min) restarts server/seats on
  failure, silent when healthy.

## The loop

1. Human dispatches one self-contained task per message: spec path, workspace
   path, acceptance criteria, exact fix where diagnosed.
2. Builder commits (never amend/rebase — history must match the room log),
   reports revision + its own suite numbers.
3. Human gates every commit with the track harness locally
   (`dark-factory-wearedevs/harness`), then steers ONE precise fix per FAIL.
4. Copy-forward: each stage starts as a copy of the previous stage folder and
   extends it; earlier stages stay frozen and keep passing.

## Cost discipline (learned mid-run)

- Diagnose with local tools before spending a seat turn: build the service
  image, probe with curl/Playwright, hand the seat an exact patch. A turn that
  starts with an exact patch is cheap; one that starts with "investigate"
  times out.
- A timed-out turn leaves half-edits (reverted fixes are the norm): `git diff`
  before assuming state, re-verify everything.
- No status/summary posts in the build room: they burn model credit and the
  ~1000-message room cap. Commit reports only.

## Track: Tablekeeper

- Stage 1: 116/120 (4 parked edge cases: skipped-hour validation, fall-back
  dedupe, cross-zone instants, moves batch).
- Stage 2: browser UI over the stage-1 API (this folder).
- Stages 3–4: policies/history/series, then replans/amendments.

## Repo layout

- `stage-1/`, `stage-2/`, … — buildable services (source + Dockerfile + RUN.md).
- `mandates/` — the generic seat mandates (no endpoints/fields/codes).
- Room export + video walkthrough accompany the submission.
