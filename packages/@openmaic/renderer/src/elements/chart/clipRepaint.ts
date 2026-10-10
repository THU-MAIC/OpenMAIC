/**
 * WebKit (Safari) workaround for SVG charts whose series are revealed through
 * an animated `<clipPath>`.
 *
 * ECharts animates line and area series in by growing a clip path from a
 * sliver to the full plot width. WebKit keeps painting the clipped group as it
 * was clipped on the first, nearly empty frame: the clip geometry reaches its
 * final size, but the group is never repainted, so the points and labels show
 * and the line does not. Setting the clip shape's geometry again, even to the
 * same value, makes WebKit repaint the group against it.
 */

/**
 * Whether the page runs on WebKit, whose SVG painter needs the repaint.
 *
 * Blink-based browsers also report `AppleWebKit` in their user agent, so they
 * are excluded by their own tokens. Browsers on iOS are all WebKit and report
 * `CriOS`/`FxiOS`/`EdgiOS` instead of `Chrome/`, so they count as WebKit.
 * Erring towards WebKit is harmless: the repaint does not change the DOM.
 */
export function isWebKitEngine(userAgent: string | undefined): boolean {
  if (!userAgent || !/AppleWebKit\//.test(userAgent)) return false;
  return !/(?:Chrome|Chromium|Edg|OPR|SamsungBrowser)\//.test(userAgent);
}

/**
 * Re-set the attributes of every shape inside a `<clipPath>` under `root` to
 * their current values, so WebKit repaints the clipped content against the
 * clip path's current geometry. The DOM ends exactly as it was; other engines
 * see no change.
 */
export function repaintClipPaths(root: Element): void {
  for (const clipPath of root.querySelectorAll('clipPath')) {
    for (const shape of Array.from(clipPath.children)) {
      for (const { name, value } of Array.from(shape.attributes)) {
        shape.setAttribute(name, value);
      }
    }
  }
}
