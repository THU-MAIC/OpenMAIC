/**
 * Platform-side fit for generated interactive pages.
 *
 * Learners rarely notice that a page inside the classroom frame can scroll, so
 * anything below the fold is effectively lost. The frame therefore shrinks a
 * page whose content is larger than its viewport until it all fits (see
 * `fitGenUiViewport` / `reduceGenUiFit`). That needs the page's real content
 * extent, which only code inside the sandboxed document can measure; this shim
 * measures it and posts it to the parent. It never changes the page itself.
 */

/**
 * Default media sizing, injected ahead of the page's own styles. `:where()`
 * carries zero specificity, so any rule the page authors still wins; it only
 * fills in what the page left unset. Without it, a canvas sized in px from its
 * container's width stops a flex container from shrinking, and repeated resizes
 * ratchet the layout wider than the frame.
 */
export const CONTENT_FIT_BASE_CSS = `:where(canvas, img, svg, video) { max-width: 100%; }`;

/**
 * Measures the page's content extent and posts it to the parent as
 * `{ __maicInteractive: true, kind: 'content-extent', viewportWidth,
 * viewportHeight, contentWidth, contentHeight, scrollRemaining }`.
 *
 * The extent is the larger of the document's scroll size and the union of the
 * rendered element boxes, so content that `overflow: hidden` ancestors clip, or
 * that spills off the right edge, still counts. An element entirely outside its
 * clipping ancestor (an off-canvas drawer, a carousel's other slides) is treated
 * as intentionally hidden and skipped, and the inside of an element that scrolls
 * on its own stays reachable through that element, so it is not counted either.
 *
 * Cheap by construction: at most one measurement per throttle window, a node
 * cap on the walk, and nothing posted when the numbers did not change. An
 * overflow is posted only after a second measurement confirms it. The
 * parent may ask for a fresh report (`__maicFitReportRequest`, answered after the
 * same throttle so a just-resized page has laid out) once it listens,
 * and may ask the page to scroll by most of a screen (`__maicFitScrollBy`).
 */
export const CONTENT_FIT_SHIM = `<script data-iframe-content-fit-shim>
(function () {
  if (window.__maicContentFitInstalled) return;
  window.__maicContentFitInstalled = true;
  var MAX_NODES = 4000;
  var THROTTLE_MS = 150;
  var CONFIRM_MS = 350;
  var SKIP = { SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, TEMPLATE: 1, NOSCRIPT: 1, TITLE: 1, HEAD: 1 };
  var LEAF = { svg: 1, CANVAS: 1, VIDEO: 1, IMG: 1, IFRAME: 1, TEXTAREA: 1, SELECT: 1, INPUT: 1 };
  var timer = null;
  var last = '';
  var measured = '';
  var confirmTimer = null;
  function scrollable(v) { return v === 'auto' || v === 'scroll'; }
  function clipped(v) { return v === 'hidden' || v === 'clip'; }
  function scroller() {
    var se = document.scrollingElement || document.documentElement;
    var b = document.body;
    if (b && b.scrollHeight - b.clientHeight > se.scrollHeight - se.clientHeight) return b;
    return se;
  }
  function measure() {
    var de = document.documentElement;
    var b = document.body;
    if (!de || !b) return null;
    var sx = (window.scrollX || 0) + (b.scrollLeft || 0);
    var sy = (window.scrollY || 0) + (b.scrollTop || 0);
    var w = Math.max(de.scrollWidth, b.scrollWidth);
    var h = Math.max(de.scrollHeight, b.scrollHeight);
    var count = 0;
    function walk(el, clip) {
      var kids = el.children;
      for (var i = 0; i < kids.length; i++) {
        if (++count > MAX_NODES) return;
        var c = kids[i];
        if (SKIP[c.tagName] || c.hasAttribute('data-maic-element-picker-overlay')) continue;
        var cs = window.getComputedStyle(c);
        if (cs.display === 'none') continue;
        var r = c.getBoundingClientRect();
        var root = c === b;
        var fixed = cs.position === 'fixed';
        var l = r.left + (fixed ? 0 : sx);
        var t = r.top + (fixed ? 0 : sy);
        var rr = r.right + (fixed ? 0 : sx);
        var bb = r.bottom + (fixed ? 0 : sy);
        var hasBox = r.width > 0 || r.height > 0;
        if (hasBox && clip && (rr <= clip.l || l >= clip.r || bb <= clip.t || t >= clip.b)) continue;
        if (hasBox && cs.visibility !== 'hidden') {
          if (rr > w) w = rr;
          if (bb > h) h = bb;
        }
        if (LEAF[c.tagName]) continue;
        var ox = cs.overflowX;
        var oy = cs.overflowY;
        if (!root && (scrollable(ox) || scrollable(oy))) continue;
        var next = clip;
        if (hasBox && (clipped(ox) || clipped(oy))) {
          next = {
            l: clipped(ox) ? Math.max(l, clip ? clip.l : -Infinity) : clip ? clip.l : -Infinity,
            r: clipped(ox) ? Math.min(rr, clip ? clip.r : Infinity) : clip ? clip.r : Infinity,
            t: clipped(oy) ? Math.max(t, clip ? clip.t : -Infinity) : clip ? clip.t : -Infinity,
            b: clipped(oy) ? Math.min(bb, clip ? clip.b : Infinity) : clip ? clip.b : Infinity
          };
        }
        walk(c, next);
      }
    }
    walk(de, null);
    var s = scroller();
    var remaining = Math.max(0, s.scrollHeight - s.clientHeight - s.scrollTop);
    return {
      __maicInteractive: true,
      kind: 'content-extent',
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      contentWidth: Math.ceil(w),
      contentHeight: Math.ceil(h),
      scrollRemaining: Math.floor(remaining)
    };
  }
  function report() {
    var m;
    try { m = measure(); } catch (e) { return; }
    if (!m) return;
    // An overflow is only posted once a second measurement agrees: right after
    // a resize, a page's own handlers can leave stale px sizes for a moment,
    // and the host would otherwise shrink the frame for a transient.
    var dims = [m.viewportWidth, m.viewportHeight, m.contentWidth, m.contentHeight].join(',');
    var overflows = m.contentWidth > m.viewportWidth + 4 || m.contentHeight > m.viewportHeight + 4;
    if (overflows && dims !== measured) {
      measured = dims;
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(report, CONFIRM_MS);
      return;
    }
    measured = dims;
    var key = [m.viewportWidth, m.viewportHeight, m.contentWidth, m.contentHeight, m.scrollRemaining].join(',');
    if (key === last) return;
    last = key;
    try { window.parent.postMessage(m, '*'); } catch (e) {}
  }
  function schedule() {
    if (timer !== null) return;
    timer = setTimeout(function () { timer = null; report(); }, THROTTLE_MS);
  }
  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d) return;
    // Throttled, not immediate: the host asks right as it resizes the frame,
    // before the page's own resize handlers have run.
    if (d.__maicFitReportRequest === true) { last = ''; schedule(); }
    if (d.__maicFitScrollBy === true) {
      var s = scroller();
      try { s.scrollBy({ top: Math.max(80, s.clientHeight * 0.8), behavior: 'smooth' }); } catch (err) { s.scrollTop += s.clientHeight * 0.8; }
    }
  });
  window.addEventListener('resize', schedule);
  window.addEventListener('load', schedule);
  document.addEventListener('scroll', schedule, true);
  function start() {
    var b = document.body;
    if (!b) return;
    try {
      if (typeof ResizeObserver === 'function') {
        var ro = new ResizeObserver(schedule);
        ro.observe(document.documentElement);
        ro.observe(b);
        for (var i = 0; i < b.children.length; i++) ro.observe(b.children[i]);
      }
      if (typeof MutationObserver === 'function') {
        new MutationObserver(function (records) {
          for (var j = 0; j < records.length; j++) {
            var added = records[j].addedNodes;
            if (records[j].target === b && ro) {
              for (var k = 0; k < added.length; k++) if (added[k].nodeType === 1) ro.observe(added[k]);
            }
          }
          schedule();
        }).observe(b, { childList: true, subtree: true, attributes: true, characterData: true });
      }
    } catch (e) {}
    try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule); } catch (e) {}
    schedule();
    setTimeout(schedule, 600);
    setTimeout(schedule, 2000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
</script>`;
