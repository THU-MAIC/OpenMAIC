# Report sharing images

The completed-project report opens an in-page image preview. Two fixed canvas layouts
(1600 × 900 and 1200 × 1600) support light and dark appearances. PNGs are generated
locally; opening, switching, and saving do not call the report API or a model.

The preview uses the existing report state: facts appear immediately, a short placeholder
occupies the narrative area while analysis is pending, and saved conclusions replace it
when available. Failed analysis falls back to facts without error text in the poster.
Rendering errors are shown outside the poster and can be retried independently.

`reportShareContent` is the public projection: no conversations, detail paragraphs,
quotes, source IDs, or private report links. Summary skill counts represent practice,
not mastery. Images have no public URL or server-side storage.

## Campaign artwork and destination

Edit `reportShareCampaign` in `report-share.ts` to supply a fixed destination URL.
While the URL is empty, the preview displays an explicitly labeled example.com placeholder and its QR code. Replace it with the supplied destination before launch. It is never inferred from course names,
project IDs, study IDs, or browser location. The QR code and address use the same value.

Optional `backgrounds[orientation][theme]` point to same-origin artwork. Keep artwork
at the layout aspect ratio and reserve the dynamic content areas; do not bake learner
numbers, narrative, or a placeholder QR code into it. Editable designs and reference
PNGs make later layout changes straightforward. Substantially different layouts require
changing canvas coordinates in `report-share-image.ts`, not data or download behavior.

The preview displays the actual PNG with a download link and allows native image
long-press behavior. Mobile browsers determine the save destination; there is no promise
of automatic access to the photo library. Final integration testing should cover the
report's fullscreen container as well as real mobile saving behavior.
