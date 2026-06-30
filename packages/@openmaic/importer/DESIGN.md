# DESIGN

`maic-importer`：将 `.pptx` 文件解析为结构化 JSON，供 PPTist 等下游渲染器消费。

## 解析管线

```
.pptx (ArrayBuffer)
  ↓  parser/ZipParser ── 解压 zip，按用途分类
PptxFiles
  ↓  model/* ── XML → 结构化模型（位置、大小、层级）
PresentationData
  ↓  serializer/* ── 模型 + 主题/模板上下文 → JSON 元素
Element[]
  ↓  adapter/toPptxtojson ── 组装最终输出
Output { slides, themeColors, size }
```

入口：`src/index.ts` → `parse(buffer, options?)`

## 分层职责

| 层 | 目录 | 做什么 | 不做什么 |
|---|---|---|---|
| **parser** | `src/parser/` | zip 解压、XML 解析（SafeXmlNode）、rels 映射、单位换算 | 不解析 OOXML 业务语义 |
| **model** | `src/model/` | 解析几何与结构：位置、大小、旋转、占位符、节点类型 | 不解析视觉样式（颜色、字体、填充） |
| **serializer** | `src/serializer/` | 结合 theme/master/layout 上下文，把模型转成 JSON 元素 | 不直接读 zip |
| **adapter** | `src/adapter/` | 定义对外 JSON 类型，组装最终 Output | 不写业务逻辑 |
| **shapes** | `src/shapes/` | 生成 SVG path 字符串（200+ preset + 自定义几何） | 不决定填充/边框 |
| **utils** | `src/utils/` | 通用工具（颜色变换、媒体格式、EMF 解析、EQ 公式等） | 不引用业务类型 |

依赖方向：`adapter → serializer → model → parser`，单向。`shapes` 和 `utils` 是底层工具。

## 目录结构

```
src/
├── index.ts                    # 入口：parse() + 类型导出
├── adapter/
│   ├── types.ts                # ★ 对外 JSON 类型定义（改它 = 改协议）
│   └── toPptxtojson.ts         # 组装 Output
├── parser/
│   ├── ZipParser.ts            # .pptx → PptxFiles
│   ├── XmlParser.ts            # SafeXmlNode（null-safe DOM 包装）
│   ├── RelParser.ts            # .rels 关系映射
│   └── units.ts                # EMU / pt / px / 角度换算
├── model/
│   ├── Presentation.ts         # 组装 theme → master → layout → slide 链
│   ├── Theme.ts / Master.ts / Layout.ts / Slide.ts
│   └── nodes/                  # 各节点类型解析器
│       ├── BaseNode.ts         # 共用属性（位置、大小、旋转、xmlOrder）
│       ├── ShapeNode.ts        # sp / cxnSp
│       ├── PicNode.ts          # pic
│       ├── TableNode.ts / ChartNode.ts / GroupNode.ts / MathNode.ts
├── serializer/
│   ├── RenderContext.ts        # 每页渲染上下文（slide → layout → master → theme）
│   ├── slideSerializer.ts      # 编排：背景 → master 装饰 → layout 装饰 → slide 元素
│   ├── shapeSerializer.ts      # ★ Shape/Text 判定、preset 路径、自适应
│   ├── textSerializer.ts       # TextBody → HTML 富文本
│   ├── tableSerializer.ts      # 表格样式级联
│   ├── chartSerializer.ts      # 图表数据提取
│   ├── imageSerializer.ts      # 图片/视频/音频
│   ├── mathSerializer.ts       # OMML → LaTeX
│   ├── groupSerializer.ts      # ★ 坐标空间缩放 + flip/rotation 烘焙
│   ├── StyleResolver.ts        # 颜色/填充 → CSS
│   ├── backgroundSerializer.ts # 背景填充
│   └── borderMapper.ts         # 线型 → dasharray
├── shapes/
│   ├── presets.ts              # 200+ OOXML preset 几何
│   ├── customGeometry.ts       # 自定义几何 → SVG path
│   └── shapeArc.ts             # 弧形计算
├── utils/
│   ├── color.ts                # OOXML 颜色变换全套
│   ├── media.ts                # MIME / 路径
│   ├── mediaWebConvert.ts      # TIFF/EMF/JXR → PNG
│   ├── emfParser.ts            # EMF 内嵌提取
│   ├── eqFieldParser.ts        # Word EQ 域公式 → LaTeX
│   ├── rgbaToPng.ts            # RGBA → PNG 编码
│   └── urlSafety.ts            # 外链白名单
├── export/
│   └── serializePresentation.ts  # 调试用：扁平化输出
└── types/
    └── vendor-shims.d.ts
```

★ 标记的是定位问题时最常修改的文件。

## 核心设计点

### 模型层不感知样式
`model/*` 只解析"是什么、在哪里、多大"。视觉样式（颜色、字体、填充）留给 serializer 层，因为需要 theme/master/layout 的级联解析。

### Serializer 是纯映射
`*ToElement(node, ctx, order)` 输入模型 + 上下文，输出 JSON 元素，无副作用。定位 bug 时只需怀疑对应的 serializer 文件。

### Group 坐标烘焙
`groupSerializer.ts` 处理两件事：
1. **chOff/chExt 缩放**：子元素坐标从 group 内部坐标系映射到外层坐标
2. **flip/rotation 烘焙**：group 的变换折算进子元素，输出的 group 始终中性（`rotate:0`, `isFlipH/V:false`）

### 元素层级（order）
`layoutElements`（master + layout 装饰）和 `elements`（slide 内容）分开输出。`layoutElements` 内部，layout 元素的 order 会加偏移量，保证始终在 master 元素之上。每个元素的 `order` 来自 `xmlOrder`（文档深度优先遍历索引）。

### 单位约定
- 对外 JSON 一律 **pt**（`left/top/width/height`）
- 颜色一律 `#RRGGBB`，角度一律 deg
- 内部 EMU 在 model 层转 px，adapter 层 px → pt

## 输出结构概览

完整类型定义见 `src/adapter/types.ts`。

| `type` | 关键字段 |
|---|---|
| `text` | `content`(HTML), `vAlign`, `isVertical`, `autoFit` |
| `shape` | `shapType`, `path`, `keypoints`, `content`, `vAlign` |
| `image` | `src`, `geom`, `rect`(裁切), `filters` |
| `table` | `data[][]`, `borders`, `rowHeights`, `colWidths` |
| `chart` | `chartType`, `data`, `colors` |
| `group` | `elements[]`（坐标已转换，变换已烘焙） |
| `math` | `latex`, `picBase64`, `text` |
| `video`/`audio` | `src`, `blob` |

## 参考实现

- `src1/`：原版 JS 实现，**只读不改**，作为参考

## 脚本

| 命令 | 用途 |
|---|---|
| `npx tsx scripts/transvert.ts <file.pptx> [out.json]` | 用本库解析（开发主力，直接跑源码无需构建） |
| `npx tsx scripts/transvert.js <file.pptx> [out.json]` | 用 pptxtojson 原版解析 |
| `node scripts/extract-pptx-structure.js <file.pptx> [outDir]` | 解压 .pptx 查看源 XML |
| `pnpm build` | Rollup 打包 + 生成 .d.ts → dist/ |
| `pnpm lint` | ESLint 检查 |
