## REQUIRED: fill the frame, never scroll the page

The page is shown in a frame at least 1280×720 CSS pixels. Its exact size and aspect ratio vary with the learner's window: it may be wider than 16:9 or noticeably taller, and it may change while the page is open.

- Lay the page out to fill the whole viewport, full width and full height. Size the top-level layout from the viewport, not from fixed pixel dimensions.
- Keep everything visible at once with no page-level scrolling: the document must never be taller or wider than the viewport. When content does not fit, make it more compact or rearrange it; do not let the page grow.
- Size controls, canvases and visualizations to the space actually available and re-measure when the viewport resizes. Do not confine the content to a fixed narrow column or a fixed-size box surrounded by empty space.
- Only a region whose content is inherently open-ended, such as console output or a long log, may scroll inside itself.
