# Report sharing images

A report opens an in-page preview of one fixed 1200 × 1500 (4:5) PNG, with light and
dark themes. The preview scales to available space; exported pixels remain fixed.
Closing returns focus to the report. Saving and native image long-press are supported;
the browser determines the destination, with no promise of automatic photo-library access.

`reportShareContent` includes only course-authored title/concepts, recorded completion,
summary counts, practiced skill receipts and saved test/quiz results. Empty sections are
omitted. The congratulatory heading is used only when `requiredComplete` is true; unfinished
projects use a neutral achievement heading. The invitation and campaign link/QR sit between
the project title and factual results. Counts represent recorded practice, not mastery or rankings.
An open two-column checklist sits above naturally wrapping, content-sized concept chips;
saved results form a separate bottom bar.

The projection does not read analysis, findings, quotes, conversations or evidence. There
is no analysis placeholder or derived narrative. Generating/ready/failed analysis and
unrelated report revisions produce the same projection and do not redraw an open image.
The dialog keeps a study identity boundary, but its drawing dependencies are only public
image data, locale, theme and image retry. The original report GET/POST/polling is unchanged;
sharing does not generate a report, call a model, store an image or create a public image URL.

Arabic text uses RTL within fixed slots; numeric runs, scores, URLs and branding retain
LTR order. Wrapping preserves words and grapheme clusters. Only needed fonts are awaited;
font failures use system fonts. Logo/QR/artwork failures can be retried independently.

## Campaign destination and artwork

Set `reportShareCampaign.url` in `report-share.ts` to the supplied fixed campaign URL.
Until it is supplied, the authorized example.com destination and QR are visibly marked as
an example. Replace it before public promotion and regenerate any saved sample images.
The URL is never inferred from project/study IDs or browser location.

`backgrounds.light` and `backgrounds.dark` optionally point to same-origin decorative
artwork for the single 4:5 layout. Keep dynamic data and QR areas clear. Substantial artwork
layout changes require updating canvas coordinates, not adding a general editor.

Real mobile saving and native fullscreen remain integration acceptance items.
