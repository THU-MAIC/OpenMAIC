# maic-renderer 设计稿（v1：只读画布）

> 配套计划：`docs/superpowers/plans/2026-05-28-maic-renderer-package.md`
> 原始 spec：`docs/superpowers/specs/2026-05-28-maic-renderer-package-design.md`

## 1. 目标

把 OpenMAIC 主仓 `components/maic-renderer/` 中的只读画布部分抽成独立 workspace 包，让任意 React + Tailwind 4 项目都能"装包 → 传 Slide → 直接渲染"。

**v1 范围限定为只读画布**（对应主仓 `Editor/ScreenCanvas.tsx` 子树）。编辑能力（`Editor/Canvas/*`、`Operate/*`、ProseMirror live editor）留给 v2。

理由：
1. 闭环最小可用，跟 `pptxtojson-pro` 形成「产 Slide → 渲 Slide」对子。
2. 编辑器接口面（选中态、命令、撤销、剪贴板、协作）定型后难改，第一版强行定下来大概率返工。
3. 只读包本身有独立价值（嵌课件、报告、回放、PDF 导出预览等）。

## 2. 设计决策

| # | 决策点 | 选择 | 理由 |
|---|--------|------|------|
| D1 | 范围 | 分两步：v1 只读 + v2 编辑 | 闭环最小，风险可控 |
| D2 | 数据 API | **纯 Props 主**；同时导出可选 Provider | 上手最快，进阶用户也照顾到 |
| D3 | 样式 | **要求消费者使用 Tailwind 4** | 工作量最小，跟主仓工程实践一致 |
| D4 | 特效层 | **包含**，4 个全做成可选 props，默认关 | 还原"OpenMAIC 同款画布"必备，但默认零负担 |
| D5 | 业务耦合元素 | **暴露 renderImage / renderVideo 插槽**，包内默认渲原生标签 | 包不感知业务，消费者按需注入 |
| D6 | i18n | 包不带文案 | UI 文案下放给消费者 |
| D7 | ProseMirror | v1 不依赖 | 只读用 dangerouslySetInnerHTML 就够，体积大幅缩小 |
| D8 | 包发布 | workspace 包，未来可发 npm；当前名 `maic-renderer`（同 `pptxtojson-pro` 风格） | 一致性 |

## 3. 对外 API

### 3.1 主入口

```ts
import { SlideCanvas, type SlideCanvasProps } from 'maic-renderer';

interface SlideCanvasProps {
  /** 单页幻灯片数据（PPTist 风格） */
  slide: Slide;
  /** 画布缩放，默认 1 */
  scale?: number;
  /** 可选：覆盖 slide.background */
  background?: SlideBackground;
  /** 可选：4 个播放特效，默认全关 */
  effects?: {
    laser?:     { elementId: string; color?: string; duration?: number };
    spotlight?: { elementId: string };
    highlight?: { elementId: string };
    zoom?:      { elementId: string; scale: number };
  };
  /** 可选：图片渲染插槽，消费者可注入 placeholder/retry 逻辑 */
  renderImage?: (el: PPTImageElement, resolvedSrc: string) => React.ReactNode;
  /** 可选：视频渲染插槽 */
  renderVideo?: (el: PPTVideoElement) => React.ReactNode;
  /** 可选：元素点击 */
  onElementClick?: (el: PPTElement, event: React.MouseEvent) => void;
  /** 透传外层 */
  className?: string;
  style?: React.CSSProperties;
}
```

### 3.2 Provider 高阶模式（可选）

```tsx
import { SlideRendererProvider, useSlideContext } from 'maic-renderer';

<SlideRendererProvider slide={slide} scale={0.9}>
  <SlideCanvas />
  <MyCustomOverlay />  {/* 子组件 useSlideContext() 拿数据 */}
</SlideRendererProvider>
```

### 3.3 元素子组件（细粒度复用）

```ts
import {
  BaseTextElement, BaseShapeElement, BaseImageElement,
  BaseLineElement, BaseChartElement, BaseLatexElement,
  BaseTableElement, BaseVideoElement, BaseCodeElement,
} from 'maic-renderer/elements';
```

### 3.4 类型

```ts
import type {
  Slide, PPTElement, SlideBackground, SlideTheme,
  PPTTextElement, PPTShapeElement, PPTImageElement,
  PPTLineElement, PPTChartElement, PPTLatexElement,
  PPTTableElement, PPTVideoElement, PPTCodeElement,
  ImageElementClip, ImageElementFilters,
  Gradient, GradientType, PPTElementOutline, PPTElementShadow,
} from 'maic-renderer/types';
```

## 4. 包结构

```
packages/maic-renderer/
├── package.json
├── README.md
├── DESIGN.md
├── tsconfig.json
├── rollup.config.js
└── src/
    ├── index.ts                  # 主入口
    ├── SlideCanvas.tsx           # 替代 ScreenCanvas（props 驱动）
    ├── SlideElement.tsx          # 替代 ScreenElement
    ├── context.tsx               # Provider + useSlideContext
    ├── effects/
    │   ├── index.ts
    │   ├── HighlightOverlay.tsx
    │   ├── SpotlightOverlay.tsx
    │   ├── LaserOverlay.tsx
    │   └── ZoomWrapper.tsx
    ├── elements/
    │   ├── index.ts
    │   ├── text/BaseTextElement.tsx
    │   ├── shape/
    │   │   ├── BaseShapeElement.tsx
    │   │   ├── GradientDefs.tsx
    │   │   └── PatternDefs.tsx
    │   ├── image/
    │   │   ├── BaseImageElement.tsx
    │   │   ├── ImageOutline.tsx
    │   │   ├── useClipImage.ts
    │   │   └── useFilter.ts
    │   ├── line/BaseLineElement.tsx
    │   ├── chart/
    │   │   ├── BaseChartElement.tsx
    │   │   └── Chart.tsx
    │   ├── latex/BaseLatexElement.tsx
    │   ├── table/BaseTableElement.tsx
    │   ├── video/BaseVideoElement.tsx
    │   ├── code/BaseCodeElement.tsx
    │   └── shared/
    │       ├── ElementOutline.tsx
    │       ├── useElementFill.ts
    │       ├── useElementOutline.ts
    │       ├── useElementShadow.ts
    │       └── useElementFlip.ts
    ├── hooks/
    │   ├── useSlideBackgroundStyle.ts
    │   └── useViewportSize.ts
    ├── utils/
    │   ├── cn.ts
    │   ├── geometry.ts
    │   └── element.ts
    └── types/
        ├── slides.ts             # 从 lib/types/slides 拷贝
        ├── effects.ts            # 新增
        └── index.ts
```

## 5. 依赖

**peerDependencies**：

```json
{
  "react": ">=18",
  "react-dom": ">=18",
  "motion": ">=11",
  "tailwindcss": ">=4"
}
```

**dependencies**（运行时必备）：

- `katex` — latex 渲染
- `tinycolor2` — 颜色工具
- `lucide-react` — 图标
- `clsx`、`tailwind-merge` — `cn` helper

**chart 库**：复用主仓现用方案，T10 实现阶段确认。开发阶段先 inline 进 dependencies，若体积过大改 peerDep。

**ProseMirror 系列**：v1 完全不依赖。

## 6. 构建

跟 `pptxtojson-pro` 完全一致：

```bash
pnpm build    # rollup -c && tsc --emitDeclarationOnly
```

产物：

```
dist/
├── index.{js,cjs,d.ts}
├── elements/index.{js,cjs,d.ts}
└── types/index.{js,cjs,d.ts}
```

## 7. 关键解耦点

### 7.1 ScreenCanvas → SlideCanvas

| 原 | 新 |
|----|----|
| `useCanvasStore.use.canvasScale()` | `props.scale ?? 1` |
| `useSceneSelector(c => c.canvas.elements)` | `props.slide.elements` |
| `useSceneSelector(c => c.canvas.background)` | `props.background ?? props.slide.background` |
| `useCanvasStore.use.laserElementId/Options()` | `props.effects?.laser` |
| `useCanvasStore.use.zoomTarget()` | `props.effects?.zoom` |
| `findElementGeometry(...)` | 拷贝进 `utils/geometry.ts` |

### 7.2 ScreenElement → SlideElement

`theme.fontColor` / `theme.fontName` 改成从 `props.slide.theme` 读取；`useSceneSelector` 移除。

### 7.3 BaseImageElement

包内退化成纯 `<img>` 版本（含 clip/filter/outline/shadow），所有 placeholder / retry / i18n 逻辑剥离。消费者通过 `renderImage` 注入业务版本。

### 7.4 BaseVideoElement

同上，纯 `<video>`。

### 7.5 其余 Base*Element

只有类型导入路径要改（`@/lib/types/slides` → `../../types/slides`），无业务耦合。

## 8. 验收标准

1. `pnpm --filter maic-renderer build` 通过，产出干净 dist
2. 主仓 `/maic-renderer-demo` 路由用包渲染一份手写 Slide，目视与原 `ScreenCanvas` 一致
3. v1 **不替换主仓既有调用**

## 9. v2 预告

- `Editor/Canvas/*` 抽到包内 `editing/`
- ProseMirror live editor
- 选中/拖拽/resize/旋转/裁剪/对齐线/标尺
- 撤销/重做/剪贴板
- API：`<SlideEditor slide editable onChange={...} />`

## 10. 风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| Chart 库依赖不明，包体积可能膨胀 | 中 | T10 阶段确认；若 >200KB gz 改 peerDep |
| Tailwind 4 强依赖筛掉很多消费者 | 中 | README 显著说明；v3 再考虑编译 CSS |
| 主仓 `Slide` 类型未来演进，包内拷贝版会漂移 | 低 | 后续可通过 `pptxtojson-pro` 已有的 `openmaic/types/slides.ts` 三方共享 |
| BaseImageElement 砍业务后主仓现有页面会丢功能 | **无影响** | 本次任务不替换主仓调用，主仓继续用自己的 `BaseImageElement` |
