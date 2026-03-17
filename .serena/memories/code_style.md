# Code Style & Conventions

## TypeScript
- Strict mode enabled (`"strict": true` in tsconfig)
- Target: ES2017
- Module resolution: bundler
- Path aliases: `@/*` maps to project root
- Unused vars prefixed with `_` are allowed (ESLint configured)

## Formatting (Prettier)
- Print width: 100
- Tab width: 2 (spaces, not tabs)
- Semicolons: yes
- Single quotes: yes (JS/TS), double quotes in JSX
- Trailing commas: all
- Arrow parens: always
- Bracket spacing: yes
- End of line: LF

## ESLint
- Based on `eslint-config-next` (core-web-vitals + typescript)
- `@next/next/no-img-element` turned off (dynamic AI-generated images)
- `packages/` directory is ignored
- Unused vars with `_` prefix produce warnings only

## Naming Conventions
- Files: kebab-case (e.g., `scene-renderers`, `slide-renderer`)
- Components: PascalCase
- TypeScript path alias: `@/` for imports from project root

## Project Structure (Next.js App Router)
- `app/` - Pages and API routes
- `components/` - React components organized by feature
- `lib/` - Business logic, utilities, hooks, stores, types
- `configs/` - Configuration constants (themes, fonts, shapes, etc.)
- `packages/` - Workspace packages (mathml2omml, pptxgenjs)
- `skills/` - OpenClaw integration skills
- `public/` - Static assets
