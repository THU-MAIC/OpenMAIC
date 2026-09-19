# SKILL



`maic-importer` 开发规范。请先读 `DESIGN.md` 了解架构。



## 还原质量迭代（必读）



项目根目录 [`iterate-prompt.md`](../../iterate-prompt.md) 规定如何从 `comparison_run` 拉低分、聚类、写报告。每批迭代交付：



- `iteration-<version>-report.md`（仓库根目录）

- 针对本包的解析侧修复（渲染问题在 `packages/@openmaic/renderer`）



**test-0601-002**（deck：`第一节 养老服务管理概述`）要点：



| 现象 | 侧 | 查哪里 |

|---|---|---|

| Logo 上多 5 个空心圆 | 解析 | `layoutElements` 里 master 组「组合 7」；子椭圆 `grpFill` 勿把父组 fill 摊到每个 child → `shapeSerializer.ts` |

| 照片应是圆却变方 | 解析 | `p:pic` + `custGeom` → `imageSerializer.resolvePresetGeom` |

| 画布四周边框 | 渲染 | `SlideCanvas` `chrome`（截图须 `false`） |

| 文字整体偏上 | 解析+渲染 | `bodyPr@anchor` → `vAlign` → `transformParsedToSlides` + `BaseTextElement` |

| 正文偏粗、换行少 | 解析+渲染 | `replaceFontFamilyInHtml` / 文本框 `width` |



调试时 **一定要看 `layoutElements`**，Logo/页脚/master 装饰常在这里，不在 `elements`。



```bash

# 仓库根：拉低分

node --env-file=.env.development scripts/inspect-low-scores.mjs test-0601-002



# 本包：JSON（含 layoutElements）

npx tsx scripts/transvert.ts /path/to.pptx ./out.json

node -e "const s=require('./out.json').slides[1]; console.log(s.layoutElements?.length, s.elements?.length)"

```



## 修 bug 的标准流程



```bash

# 1. 解压 pptx 看源 XML

node scripts/extract-pptx-structure.js ./xxx.pptx ./out



# 2. 生成修改前的 JSON

npx tsx scripts/transvert.ts ./xxx.pptx ./before.json



# 3. 改代码



# 4. 生成修改后的 JSON，diff 对比

npx tsx scripts/transvert.ts ./xxx.pptx ./after.json

```



定位思路：JSON 数值错 → serializer；节点类型错 → model/Slide.ts；颜色错 → StyleResolver + color.ts；模板继承错 → RenderContext.ts；**master/layout 装饰** → `slideSerializer` 的 `layoutElements` + `shapeSerializer` 的 `grpFill` / `ln`+`noFill` vs `lnRef`。



## OOXML 陷阱（本 deck 已踩）



1. **`<a:grpFill/>`**：子形状由组级合成，JSON 里每个 child 的 `fill` 应为 `transparent`，**不能**把 `grpSpPr` 的 solidFill 抄到每个椭圆上，也**不能**用 `fillRef` 补色（test-0601-002 的 5 个 Logo 圆点即此类）。

2. **`<a:ln><a:noFill/></a:ln>`**：显式无描边优先于 `lnRef`（见 `shapeSerializer` 中 `noFillSuppressed`）。

3. **`p:pic` 圆形裁剪**：常为 `custGeom` 而非 `prstGeom prst="ellipse"`；仅读 `prstGeom` 会得到 `rect`。

4. **分层顺序**：`layoutElements`（master+layout）先画，`elements`（slide）后画——与 `transformParsedToSlides` 一致。



## 代码规范



- **TypeScript strict**，不用 `@ts-ignore`，`any` 仅在必要时局部使用并加注释

- **注释解释"为什么"**，不解释"做了什么"

- **用已有工具**：单位用 `parser/units.ts`，XML 用 `SafeXmlNode`，颜色用 `utils/color.ts`

- commit message：中文，动词起头，点出修了什么

  - 好：`fix(text): 修复 solidFill/gradFill 互斥覆盖导致渐变遮盖文字颜色`

  - 坏：`fix bug` / `update`

- 一个 commit 只做一件事，重构和 bug 修复分开提



## 类型协议（重要）



`src/adapter/types.ts` 是与下游的 **协议**，修改需谨慎：



- **不改** 已有字段的名字或类型

- **不把** 可选字段改为必选

- **新增** 字段一律 `?:` 可选，附 JSDoc 说明

- 长度单位 pt，颜色 `#RRGGBB`，角度 deg



`model/*` 的内部类型可以自由重构，但保持"模型层不感知样式"原则。



## 分层红线



| 层 | 该做 | 不该做 |

|---|---|---|

| parser | 解压、XML 解析、单位换算 | 解析 OOXML 业务语义 |

| model | 解析几何与结构 | 解析视觉样式 |

| serializer | 模型 + 上下文 → JSON 元素 | 直接读 zip |

| adapter | 定义类型、组装输出 | 写业务逻辑 |

| shapes | 输出 SVG path | 决定填充/边框 |

| utils | 通用工具 | 引用业务类型 |



依赖方向：`adapter → serializer → model → parser`，**禁止反向**。



## 高风险文件



改这些文件前请格外注意：



**`groupSerializer.ts`** — chOff/chExt 缩放 + flip/rotation 烘焙。改前想清楚 `flipH+flipV → +180°` 等价规则。新增 child 特殊缩放规则时做 fast-path 短路。



**`shapeSerializer.ts`** — 800+ 行，承担 Shape/Text 判定、preset 路径、自适应、`grpFill`/`fillRef`/`lnRef` 互斥等。调整 Shape vs Text 判定前，先用 `src1` 跑同样的 .pptx 对比。



**`imageSerializer.ts`** — `resolvePresetGeom` 影响下游 `clip`；`custGeom` 与 `prstGeom` 都要覆盖。



**`presets.ts`** — 200+ preset 共享辅助函数，修一个前看调用方，避免误伤。



**`parser/units.ts`** — 被广泛依赖，**不要改现有函数签名**，需要新单位就加新函数。



## 注意事项



- `*.pptx`、`slides.json`、`out/`、`dist/` 已在 .gitignore 中，提交前 `git status` 确认不要带入

- `src1/` 是原版参考实现，**只读不改不构建**

- 改了 `adapter/types.ts` 需在 commit body 写明协议变更

- 改解析后应用**新 version** 重跑 compare，避免与旧批次 reply 混淆


