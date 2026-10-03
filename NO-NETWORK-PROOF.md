# No-network proof (2026-10-04)

All four stages build clean (0 TS errors) and serve `/health -> {"status":"ok"}`
from containers on a Docker `--internal` network (no outbound route; DNS fails):

- `docker network create --internal iso`
- `docker build -t tknetN stage-N` (0 ERROR lines each)
- `docker run --network=iso tknetN` + client container on same net:
  `wget http://tknetN:8080/health` -> `{"status":"ok"}` for N=1..4
- Egress check from same net: `wget https://registry.npmjs.org/` -> bad address (no DNS/route)

Note: with `--network=none` even loopback is down, so `--internal` is the
correct harness-equivalent isolation: service reachable, internet unreachable.
