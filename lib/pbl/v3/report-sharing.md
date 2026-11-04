# Report sharing images

A report opens an in-page preview of one fixed 1200 × 1500 (4:5) PNG, with light and
dark themes following the current workbench appearance, with no separate theme selector.
The image is the visible dialog surface; close and download icons overlay its corners and
are not drawn into the exported PNG. Accessible dialog labels remain hidden visually.
The preview scales to available space; exported pixels remain fixed.
Closing returns focus to the report. Saving and native image long-press are supported;
the browser determines the destination, with no promise of automatic photo-library access.

`reportShareContent` includes only course-authored title/concepts, recorded completion,
summary counts, practiced skill receipts and saved test/quiz results. Empty sections are
omitted. The congratulatory heading is used only when `requiredComplete` is true; unfinished
projects use a neutral achievement heading. The official OpenMAIC wordmark and workshop heading lead the image.
The invitation, campaign link and QR follow the learner’s results at the bottom. Counts represent recorded practice, not mastery or rankings.
An open two-column checklist sits above naturally wrapping, content-sized concept chips;
saved results form a separate bar above the invitation. There is no repeated brand footer.

The projection does not read analysis, findings, quotes, conversations or evidence. There
is no analysis placeholder or derived narrative. Generating/ready/failed analysis and
unrelated report revisions produce the same projection and do not redraw an open image.
The dialog keeps a study identity boundary, but its drawing dependencies are only public
image data, locale, theme and image retry. The original report GET/POST/polling is unchanged;
sharing does not generate a report, call a model, store an image or create a public image URL.

Arabic text uses RTL within fixed slots; numeric runs, scores, URLs and branding retain
LTR order. Wrapping preserves words and grapheme clusters. Only needed fonts are awaited;
font failures use system fonts. Logo/QR/artwork failures can be retried independently.

## Clickable preview versus saved PNG

When a valid destination exists, the whole invitation block in the report preview is an
accessible link that opens a new tab. Image coordinates and the HTML hit area use the same
layout definition, so resizing keeps them aligned. The rest of the image does not navigate.
The download control stays above this link and only saves the PNG; it does not open the course.

The exported PNG contains pixels, not HTML hyperlinks. Clicking its printed URL in a local
image viewer or social-media post cannot be guaranteed to navigate. Recipients can scan or
recognize the embedded QR, or enter the printed address; viewer-specific text recognition is
not a feature promised by this export. The QR encodes the destination directly and does not
create hosting, permissions or per-course routing.
The printed URL stays complete, using readable Unicode where re-entering it preserves the
same destination. Invisible/formatting characters and whitespace stay escaped so the visible
address cannot silently omit them. Canvas fits long addresses within the existing URL slot without an ellipsis;
the QR and preview link retain the validated destination. Prefer a short campaign URL for legibility.

## Campaign destination and artwork

Set `reportShareCampaign.url` in `report-share.ts` to the supplied fixed, public introductory-course URL.
The empty/invalid case omits the entire promotion block, including link and QR, while keeping
achievement preview/download available. There is no example.com fallback or placeholder caption.
The label is “Vibe Coding 工作坊前置课入口” in Chinese. The QR is generated from the same configured URL using the existing QR export utility; no separate QR image is needed. Updating this source configuration
requires an application release, not a course-package update. It is intentionally one fixed campaign
input, without per-course lookup, a routing service or another network request.

The existing course route is `/classroom/<id>`. A production URL can be agreed before deployment
once the domain and imported course ID are fixed. Importing or knowing the URL does not publish
the course: the existing owner/role-controlled `POST /api/stages/<id>/publish` operation makes it
public. Verify the final entry using a different learner account before setting the campaign URL.
Do not copy a private localhost/classroom address or infer a destination from a learner's study.
An existing official campaign/landing URL may be used instead, allowing its destination to change
without changing the printed link on already-saved images. No redirect service is added by this PR.

The official logo is a transparent PNG rendered from the supplied `3.svg`, trimmed to its artwork.
This keeps the full supplied wordmark, avoids a font imitation and avoids SVG filter/mask decoding
in mobile canvas exports. The transparent wordmark is drawn directly onto both backgrounds, without a contrasting logo panel.

`backgrounds.light` and `backgrounds.dark` optionally point to same-origin decorative
artwork for the single 4:5 layout. Keep dynamic data and QR areas clear. Substantial artwork
layout changes require updating canvas coordinates, not adding a general editor.

Real mobile saving and native fullscreen remain integration acceptance items.

## Report source records

The report keeps detailed evidence and conversations inside one learning-records disclosure,
collapsed by default. Analysis reference buttons open both the enclosing disclosure and the
specific source, scroll it into view and focus its summary. Records, citation IDs, report
fetching, model input and generation remain unchanged. Reopening a report starts collapsed.
