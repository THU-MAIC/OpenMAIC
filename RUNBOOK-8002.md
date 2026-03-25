# OpenMAIC 8002 Runbook

## Correct startup mode

This project is built with Next.js `output: 'standalone'`.

Do not use `pnpm start` for the production-style 8002 service. It prints a warning and may not behave as expected with the standalone output.

Use the standalone server entry instead:

```bash
cd /home/sunli/MyWork/myproject/OpenMAIC
PORT=8002 HOSTNAME=0.0.0.0 OPENMAIC_PROJECT_ROOT=/home/sunli/MyWork/myproject/OpenMAIC node .next/standalone/server.js
```

Or use the helper script:

```bash
cd /home/sunli/MyWork/myproject/OpenMAIC
./scripts/start-8002.sh
```

## Detached startup with tmux

```bash
cd /home/sunli/MyWork/myproject/OpenMAIC
tmux new-session -d -s openmaic-svc-8002 './scripts/start-8002.sh >>/tmp/openmaic-8002.log 2>&1'
```

## Verify service

```bash
ss -ltnp 'sport = :8002'
curl http://127.0.0.1:8002/api/health
curl http://127.0.0.1:8002/api/classroom
```

## Stop service

```bash
tmux kill-session -t openmaic-svc-8002
```

## Rebuild when needed

If server code changed, rebuild before restarting:

```bash
cd /home/sunli/MyWork/myproject/OpenMAIC
pnpm build
tmux kill-session -t openmaic-svc-8002 || true
tmux new-session -d -s openmaic-svc-8002 './scripts/start-8002.sh >>/tmp/openmaic-8002.log 2>&1'
```

## Why the public-course count dropped from 4 to 3

`node .next/standalone/server.js` changes the working directory to `.next/standalone`.

Also note that many Linux hosts already define a shell `HOSTNAME` value such as `k8s-node3-gpu`. If you pass that through unchanged, Next.js may bind to `127.0.1.1` instead of `0.0.0.0`. The helper script forces `HOSTNAME=0.0.0.0` unless `OPENMAIC_HOSTNAME` is set explicitly.

Before the fix in `lib/server/classroom-storage.ts`, server-side classroom storage used `process.cwd()`, so the live service read:

```text
.next/standalone/data/classrooms
```

instead of:

```text
data/classrooms
```

That standalone snapshot only had 3 classroom JSON files, so `/api/classroom` returned 3 public courses.
