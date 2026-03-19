
# Add Vitest testing infrastructure and initial unit tests for core utilities

## Summary

This PR introduces a minimal testing foundation for the project using **Vitest**.

As the project continues to grow and receive more pull requests, having a lightweight unit testing setup helps catch regressions early and provides clear patterns for contributors when adding tests.

Vitest was chosen because it works well with modern TypeScript and ESM-based projects, offers fast execution, and provides a developer-friendly API similar to Jest.

The goal of this PR is **not to introduce full test coverage**, but to establish the **initial testing infrastructure and patterns** that contributors can follow when writing tests in the future.

---

## Related Issues

Closes #79

---

## Changes

- Set up **Vitest configuration**
- Add **`pnpm test` script** to `package.json`
- Add initial **unit tests for core utility modules**:
  - `geometry.ts`
  - `element.ts`
  - `logger.ts`
- Provide example tests demonstrating how to test pure utility functions
- Prepare the repository for **CI integration of tests**

The tests intentionally focus on **pure logic utilities**, which ensures they run reliably without requiring DOM mocking or complex runtime environments.

---

## Type of Change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [x] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to change)
- [ ] Documentation update
- [x] Refactoring (no functional changes)
- [x] CI/CD or build changes

---

## Verification

### Steps to reproduce / test

1. Install dependencies

```bash
pnpm install
```

2.Run project checks
```
pnpm check
pnpm lint
npx tsc --noEmit
```

3.Run unit tests
```
pnpm test
```

Expected result:
✓ geometry.test.ts
✓ element.test.ts
✓ logger.test.ts

Test Files  3 passed
Tests       9 passed

What I personally verified : 
1. Confirmed that all unit tests pass locally using Vitest
2. Verified compatibility with existing lint and TypeScript checks
3. Ensured that tests only target pure utility functions to avoid side effects
4. Confirmed that logger tests execute without runtime errors
5. Ensured test structure provides a clear pattern for future contributors

Edge cases verified:
1.Handling of null return values from geometry utilities
2.Deduplication behavior in alignment utilities
3.Safe invocation of logger methods

Evidence:
[x] CI passes (pnpm check && pnpm lint && npx tsc --noEmit)
[x] Manually tested locally
[ ] Screenshots / recordings attached (if UI changes)

Checklist:
- [x] My code follows the project's coding style
- [x] I have performed a self-review of my code
- [x] I have added/updated documentation as needed
- [x] My changes do not introduce new warnings


