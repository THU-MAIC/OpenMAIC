import { INTER_FONT_FACE_CSS } from '../../../lib/video-export/emit-hyperframes/inter-font.js';

export const missingFontProjectHtml = `<!doctype html><html><head><style>
  ${INTER_FONT_FACE_CSS}
  p { font-family: MissingProbeFace, "OpenMAIC Inter", sans-serif; }
  .picker { font-family: "LXGW WenKai", sans-serif; }
  .shorthand { font: 700 16px MissingShorthand, sans-serif; }
  .generic { font-family: system-ui, sans-serif; }
  </style></head><body style="margin:0">
  <div id="sample" data-composition-id="sample" data-start="0" data-duration="1" data-no-timeline
    data-width="320" data-height="180" style="background: white; width:320px; height:180px">
    <p>Missing font fallback</p><span style="font-family: Inter, sans-serif">Bundled Inter</span>
    <div style="font-family: Roboto, sans-serif">Bundled Roboto</div>
    <div style="font-family: Calibri, sans-serif">Bundled alias</div>
    <div class="picker">Picker font</div><div class="shorthand">Shorthand</div>
    <div class="generic">Generic first</div>
  </div></body></html>`;
