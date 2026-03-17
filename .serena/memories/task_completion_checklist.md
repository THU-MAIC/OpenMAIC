# Task Completion Checklist

When a coding task is completed, run the following checks:

1. **Lint**: `pnpm lint` — Ensure no ESLint errors
2. **Format check**: `pnpm check` — Ensure code is formatted correctly
3. **Auto-format** (if needed): `pnpm format` — Fix formatting issues
4. **Build**: `pnpm build` — Ensure the project builds without errors
5. **Type check**: TypeScript strict mode is enforced by the build step

## Notes
- No test framework is currently configured in the project
- The project uses Next.js App Router — changes to API routes are in `app/api/`
- Workspace packages (`packages/*`) are built during `pnpm install` (postinstall script)
- If modifying workspace packages, rebuild them manually before testing
