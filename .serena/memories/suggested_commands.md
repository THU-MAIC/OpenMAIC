# Suggested Commands

## Development
```bash
pnpm install          # Install all dependencies (runs postinstall for workspace packages)
pnpm dev              # Start Next.js dev server (http://localhost:3000)
pnpm build            # Production build
pnpm start            # Start production server
```

## Code Quality
```bash
pnpm lint             # Run ESLint
pnpm check            # Check formatting with Prettier
pnpm format           # Auto-format with Prettier
```

## Docker
```bash
docker compose up --build    # Build and run via Docker (port 3000)
docker compose up -d         # Run in background
```

## Configuration
```bash
cp .env.example .env.local   # Create local environment config
```

## System Utilities (Linux)
```bash
git status / git diff / git log   # Version control
ls / find / grep                  # File system navigation
node / npx / pnpm                 # Node.js tooling
```

## Workspace Packages (built during postinstall)
```bash
cd packages/mathml2omml && npm run build   # Build MathML converter
cd packages/pptxgenjs && npm run build     # Build PPTX generator
```
