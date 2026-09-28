# Startup Modes

## Goal

Help the user choose how OpenMAIC should run before you start anything.

## Options

### 1. Development Mode

Recommended for first-time setup and debugging.

```bash
pnpm dev
```

Tradeoff:

- Fastest feedback loop
- Best for validating config changes
- Not representative of production startup

### 2. Production-Like Local Mode

Recommended when the user wants behavior closer to a deployed server.

```bash
pnpm build && pnpm start
```

Tradeoff:

- Closer to production
- Slower startup than `pnpm dev`

### 3. Docker Compose

Use only when the user explicitly wants containerized startup or wants to avoid local Node setup details.

```bash
docker compose up --build
```

This starts the app and PostgreSQL (courses are stored server-side) in single-user mode, published on `127.0.0.1:3000` only. To reach it from other machines, start with `OPENMAIC_PUBLISH_ADDRESS=0.0.0.0` and set `ACCESS_CODE` in `.env.local` first; without an access code anyone who can reach it shares, edits and can delete the single library (the server warns at startup but still runs).

Tradeoff:

- Cleaner isolation
- Heavier and slower
- Harder to debug application-level issues quickly

## Recommendation Order

1. `pnpm dev`
2. `pnpm build && pnpm start`
3. `docker compose up --build`

## Health Check

After startup, verify:

```bash
curl -fsS http://localhost:3000/api/health
```

If the skill config provides a custom `url`, use that instead.

## Confirmation Requirements

- Ask the user to choose one startup mode.
- Ask again before running the selected command.
