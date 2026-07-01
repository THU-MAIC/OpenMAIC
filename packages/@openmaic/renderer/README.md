# @openmaic/renderer

React component for rendering PPTist-style `Slide` JSON. Extracted from [OpenMAIC](https://github.com/THU-MAIC/OpenMAIC).

> **v1 = read-only canvas.** Editing (selection, drag/resize, ProseMirror inline editor) is planned for v2.

## Install

```bash
pnpm add @openmaic/renderer
# or
npm install @openmaic/renderer
```

Required peers:

- `react >= 18`
- `react-dom >= 18`
- `motion >= 11`
- `tailwindcss >= 4` — **the package emits Tailwind 4 arbitrary-value classes, consumers must use Tailwind 4**

Optional peers (install only if your slides use the corresponding element type):

- `echarts >= 5` — for chart elements
- `shiki >= 1` — for code elements

## Quickstart

```tsx
import { SlideCanvas, type Slide } from '@openmaic/renderer';

const slide: Slide = {
  id: 'demo-1',
  viewportSize: 1000,
  viewportRatio: 0.5625,
  theme: {
    backgroundColor: '#ffffff',
    themeColors: ['#5b8def'],
    fontColor: '#222222',
    fontName: 'sans-serif',
  },
  elements: [
    {
      type: 'text',
      id: 't1',
      left: 100,
      top: 80,
      width: 800,
      height: 60,
      rotate: 0,
      content: '<p>Hello, Slide</p>',
      defaultFontName: 'sans-serif',
      defaultColor: '#222',
    },
  ],
  background: { type: 'solid', color: '#ffffff' },
};

export default function Demo() {
  return (
    <div style={{ width: 800, height: 450 }}>
      <SlideCanvas slide={slide} />
    </div>
  );
}
```

The canvas auto-fits its parent container. The parent must have a defined `width × height`.

## API

### `<SlideCanvas slide effects? renderImage? renderVideo? onElementClick? scale? background? />`

The main read-only entry. Reads everything from props; zero global state.

```ts
interface SlideCanvasProps {
  slide?: Slide;                       // required unless via <SlideRendererProvider>
  scale?: number;                      // omit = auto-fit container
  background?: SlideBackground;        // overrides slide.background
  effects?: SlideEffects;              // laser / spotlight / highlight / zoom, all default off
  renderImage?: (el, src) => ReactNode;
  renderVideo?: (el) => ReactNode;
  onElementClick?: (el, event) => void;
  className?: string;
  style?: CSSProperties;
}
```

### Play-time effects

All effects are off by default. Pass any combination via `effects`:

```tsx
<SlideCanvas
  slide={slide}
  effects={{
    laser:     { elementId: 't1', color: '#ff3b30' },
    spotlight: { elementId: 't1' },
    highlight: { elementId: 't1', color: '#ff6b6b', animated: true },
    zoom:      { elementId: 't1', scale: 1.5 },
  }}
/>
```

### Media injection slots

The package's `BaseImageElement` and `BaseVideoElement` render plain `<img>` / `<video>` and know nothing about your media pipeline. Inject business behaviour via the `renderImage` / `renderVideo` slots:

```tsx
<SlideCanvas
  slide={slide}
  renderImage={(el, src) => (
    src.startsWith('placeholder:')
      ? <MyPlaceholder taskId={src} />
      : <img src={resolveCdnUrl(src)} alt="" style={{ width: '100%', height: '100%' }} />
  )}
/>
```

### `<SlideRendererProvider>` + `useSlideContext()`

Optional high-order pattern when sibling overlays need the same slide data:

```tsx
import { SlideRendererProvider, SlideCanvas, useSlideContext } from '@openmaic/renderer';

function MyAnnotationLayer() {
  const { slide } = useSlideContext();
  return <div>Annotations for {slide.id}</div>;
}

<SlideRendererProvider slide={slide} scale={0.9}>
  <SlideCanvas /> {/* reads slide/scale from context */}
  <MyAnnotationLayer />
</SlideRendererProvider>
```

### Granular components — `@openmaic/renderer/elements`

If you want to compose your own layout instead of using `SlideCanvas`, the 9 base elements are exported individually:

```ts
import {
  BaseTextElement, BaseShapeElement, BaseImageElement,
  BaseLineElement, BaseChartElement, BaseLatexElement,
  BaseTableElement, BaseVideoElement, BaseCodeElement,
  ElementOutline,
} from '@openmaic/renderer/elements';
```

Each accepts `{ elementInfo: PPTXxxElement }`. Image/Video also take a render slot.

### Types — `@openmaic/renderer/types`

```ts
import type {
  Slide, PPTElement, SlideBackground, SlideTheme,
  PPTTextElement, PPTShapeElement, PPTImageElement,
  PPTLineElement, PPTChartElement, PPTLatexElement,
  PPTTableElement, PPTVideoElement, PPTCodeElement,
  ImageElementClip, ImageElementFilters,
  Gradient, GradientType, PPTElementOutline, PPTElementShadow,
  SlideEffects, LaserEffectOptions, SpotlightEffectOptions,
  HighlightEffectOptions, ZoomEffectOptions,
} from '@openmaic/renderer/types';
```

## Tailwind 4 setup

Ensure your `tailwind.config.{ts,js}` includes the package source:

```js
export default {
  content: [
    './src/**/*.{ts,tsx}',
    './node_modules/@openmaic/renderer/dist/**/*.{js,cjs}',
  ],
};
```

## Fonts (optional, CDN-hosted)

Slides imported from PowerPoint often reference Chinese faces that aren't
installed on the viewer's machine. The package ships a `fonts.css` with
`@font-face` rules for a small whitelist of self-hosted CJK faces — import it
once at your app shell to make those faces available:

```ts
import '@openmaic/renderer/fonts.css';
```

> **Runtime dependency — read this.** The `@font-face` `src` URLs point at an
> external font host (`https://file.maic.chat/fonts/<name>.woff2`); the woff2
> files are **not** bundled in the package. So this is a hard runtime dependency:
> the host must be **reachable and CORS-enabled** from the consumer's app, or the
> browser will **silently fall back to system fonts** (no error, just different
> glyphs/metrics). If you need a different origin (self-hosting, air-gapped, a
> private CDN), change `FONT_CDN_BASE_URL` in `fonts.config.mjs` and regenerate
> with `pnpm run genfonts`.
>
> The import is **optional** — slides render fine without it, using whatever
> fonts the system provides. See [FONTS.md](./FONTS.md) for the face list and
> their licenses.

## Companion package

[`@openmaic/importer`](../importer) converts `.pptx` files to the same `Slide[]` shape, so you can do `.pptx → @openmaic/renderer` end-to-end.

## See also

- [DESIGN.md](./DESIGN.md) — package design decisions and scope
- v2 will add editing (`<SlideEditor editable onChange />`); the read-only `<SlideCanvas>` API will remain stable

## License

MIT
