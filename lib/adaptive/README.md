# Adaptive infrastructure

## Layout queries and hydration

`lib/adaptive/media-queries.ts` defines two independent rules:

- `MOBILE_LAYOUT_QUERY`: width at most 767 CSS pixels, or height at most 500 pixels with a coarse primary pointer. This includes short phone landscape viewports.
- `WORKSPACE_NARROW_QUERY`: width at most 1023 CSS pixels, preserving the workspace's existing exclusive pane behavior.

Use CSS for ordinary responsive layout. Use `useMobileLayout()` only when component structure or interactions differ. `AdaptiveProvider` passes a request UA hint; server rendering and the first hydration snapshot agree, then `matchMedia` corrects it. A UA cannot predict viewport size, so correction is expected. No pending skeleton or view-switching component is introduced. Page owners must keep audio, engines, streaming sessions and drafts outside any conditionally mounted layout.

`useMediaQuery(query, serverMatches = false)` shares one active browser change listener per query and releases it after the last subscriber leaves. Use stable query constants. Workspace migration retains its original false server hint. Neither hook is a device classifier.

## Visible viewport and safe areas

`useVisualViewport()` returns `{ width, height, offsetTop, offsetLeft, scale }`, or `null` during SSR and the first hydration render. Consumers must retain a CSS fallback. Browser viewport events are shared and coalesced per animation frame; browsers without VisualViewport use window dimensions. Geometry is not proof that a keyboard is open. Do not use it to choose mobile versus desktop layout or disable zoom.

The root viewport retains browser-default cutout avoidance rather than opting every route into `viewport-fit=cover`. Four CSS variables expose safe-area insets: `--safe-area-top`, `--safe-area-right`, `--safe-area-bottom`, `--safe-area-left`. Fixed edge controls should opt into padding, e.g. `padding-bottom: max(12px, var(--safe-area-bottom))`. Nested surfaces must avoid counting the same inset twice. The infrastructure does not globally resize or pad pages; the mobile homepage opts into these helpers locally. Physical notch-device verification remains necessary when adopting edge-to-edge page layouts.

## Homepage integration

The homepage retains one form, material upload flow, generation action and course library. Phones use a compact composer, a course-options dialog and a library drawer; desktops keep the inline library. Drafts stay in the page while these containers open and close. Touch-accessible course actions replace hover and double-click interactions on phones. Mobile homepage dialogs use responsive CSS dimensions, horizontal safe-area bounds and 16px input text. The homepage does not detect a keyboard or subscribe to VisualViewport to change its height, top position, typography or content visibility.

On phones, the course-material entry opens a dedicated view inside the existing options dialog. Return and Done restore options; the close button dismisses the dialog. Its material body shares the toolbar's rendering and page-owned upload state, uses one scroll region, and does not create a nested attachment popover. Desktop keeps the original popover.

`installPageScrollBoundary(document)` is installed for the lifetime of the phone homepage, independent of keyboard state. It contains single-touch page panning while allowing nested scroll containers to scroll in the requested direction and retaining two-finger zoom. Its listeners are removed on desktop-layout changes or unmount. It does not fix `html`/`body` or modify viewport geometry.

This change does not implement a mobile classroom, editor or multi-pane workbench. The workspace only adopts the shared media-query subscription with its existing 1024px threshold.

## Device hints for deployment integrations

`identifyRequestDevice(userAgent)` returns a best-effort classification:

- `deviceType`: `mobile | tablet | desktop | unknown`.
- `browserContext`: `wechat | browser | unknown`. Other embedded browsers are not separately detected in version 1; the `browser` bucket can include unrecognized containers.
- `os`: `ios | android | windows | macos | linux | unknown`.
- `detectionVersion`: `1`.
- `initialMobileLayout`: a rendering hint only, unsuitable for device analytics cohorts.

UA spoofing, desktop-mode iPads and unusual browsers can be misclassified. Preserve `unknown`; do not infer device type from window width. Add cases and bump the detection version when classification semantics change. Never use these hints for authorization.

No analytics collection, event endpoint, database schema or login handling is added. Deployments may reuse the classifier at their own event ingestion boundary. Preserve original visit attribution across login redirects, distinguish new registrations from returning logins, and define deduplication and attribution rules in that deployment. Device hints alone do not implement a conversion funnel.

## Validation

Run `pnpm test tests/adaptive`, `pnpm exec playwright test e2e/tests/mobile-home.spec.ts`, lint the changed files, and check TypeScript. Tests cover UA hints, distinct rules, shared listener cleanup, SSR hints, hydration correction, VisualViewport updates, fallback geometry and animation-frame coalescing. Real-device keyboard, browser-toolbar, pinch-zoom and safe-area validation cannot be replaced by these tests.
