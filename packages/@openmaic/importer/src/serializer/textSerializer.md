# textSerializer.ts 说明

本文说明 `src/serializer/textSerializer.ts` 的职责、与参考实现 `pptx-renderer-main/src/renderer/TextRenderer.ts` 的对应关系，以及输出如何进入 pptxtojson / PPTist 的数据模型。

## 定位

- **输入**：解析阶段得到的 `TextBody`（段落、run、OOXML 原始 `SafeXmlNode`）、当前幻灯片的 `RenderContext`（主题 / 母版 / 版式 / 色板 / rels），以及可选的 **`PlaceholderInfo`**（占位符类型与 idx）。
- **输出**：一段 **HTML 字符串**，写入 `adapter/types.ts` 里 **`Shape.content`** / **`Text.content`**（README 中的富文本 HTML 约定一致）。
- **不做的事**：不解析 PPTX 压缩包、不读 slide XML 文件；不渲染到浏览器 DOM；表格单元格若只需纯文本，由 `tableSerializer` 在拿到 HTML 后再 strip 标签。

## 与 `TextRenderer.ts` 的关系

| 方面 | `TextRenderer.renderTextBody` | `textSerializer.renderTextBody` |
|------|-------------------------------|----------------------------------|
| 继承与合并 | 七级段落 + run 合并、`mergeParagraphProps` / `mergeRunProps` 等 | **同一套函数与注释**，逻辑对齐 |
| 入口 | `renderTextBody(textBody, placeholder, ctx, container, options?)` | `renderTextBody(textBody, placeholder, ctx, options?)` — **无 `container`** |
| 结果 | 向 `container` 追加 `div` / `span` / `a` / `br` 等 | 返回等价结构的 **HTML 字符串** |
| 超链接 | `hlinkClick` + `isAllowedExternalUrl` | 相同；主工程使用 `src/utils/urlSafety.ts`（协议校验可与 renderer 略有差异，见该文件） |

主函数名与选项类型与 renderer 对齐：**`renderTextBody`**、**`RenderTextBodyOptions`**（如表格 `tcTxStyle` 预留的 `cellTextColor` 等）。

## 七级样式继承（与 TextRenderer 一致）

对每一段 `a:p`，按顺序把列表样式里的 **某级 `pPr`** 合并进 `MergedParagraphStyle`：

1. 母版 **`defaultTextStyle`**（按段落 `lvl` 取 `lvl{n}pPr` 或 `defPPr`）
2. 母版 **`txStyles`** 中按占位符类别选的 **`titleStyle` / `bodyStyle` / `otherStyle`**
3. 母版上与当前占位符匹配的 **占位符形状** 的 `txBody/lstStyle`
4. 版式上与当前占位符匹配的 **占位符形状** 的 `lstStyle`
5. 当前形状 **`textBody.listStyle`**
6. 段落 **`p:pPr`**
7. 每个 run 的 **`a:rPr`**（并叠在段落 `defRPr` 之上）

占位符类别由 **`getPlaceholderCategory`**（`title` / `body` / `other`）决定，用于第 2 步选 `titleStyle` 还是 `bodyStyle` 等。

Run 侧在合并 **`defRPr` + `rPr`** 后，若仍无字色，会回退到 **形状 `lstStyle` 当前级 `defRPr`**（与 TextRenderer 中注释一致：处理「空 `defRPr` 盖掉 lstStyle 色」的情况）。

## 段落与 run 的视觉效果（映射到 CSS）

- **段落**：对齐、缩进、行距（无单位 / `pt` 绝对行距）、段前段后（`pt` 或相对字号比例）、**`normAutofit`** 下的行距压缩、制表宽度（`tab-size`）。
- **绝对行距 + 段内换行**：与 TextRenderer 一样，用带 **固定高度** 的内层 `div` 包行，避免 CJK 行高与 CSS 不一致；无此需求时外层用 **`<p>`**，有行盒时用 **`<div>`** 作外层（避免在 `<p>` 内嵌块级结构）。
- **项目符号**：字符 / 自动编号、`buClr` 与 defRPr / 首 run / lstStyle 回退色；对标题等占位符类型 **抑制项目符号**（与 PowerPoint 行为一致）。
- **Run**：字号（含 autofit 缩放）、粗斜体、下划线、删除线、实色 / 渐变字、主题字、`hlink` 默认色、字距、字偶距、全大写 / small caps、上下标、文本描边 / `noFill` 等，均收敛为 **内联 `style`**；超链接输出为 **`<a target="_blank" rel="noopener noreferrer">`**。

空格与制表：连续空格用 `&nbsp;` 策略、制表用 `white-space: pre`，与 TextRenderer 的意图一致。

## 依赖

- **`StyleResolver`**：`resolveColor`、`resolveColorToCss`、渐变解析用到的单位换算等。
- **`RenderContext`**：主题、母版、版式、当前 slide rels（外链 id）。
- **`urlSafety`**：外链 URL 白名单。

## 调用方

- **`shapeSerializer`**：`renderTextBody(node.textBody, node.placeholder, ctx)`。
- **`tableSerializer`**：`renderTextBody(cell.textBody, undefined, ctx)`，再按需要做纯文本化。

## 与 TextRenderer 的已知差异（可接受）

- **外层段落标签**：无行盒包装时使用 **`<p>`** 以贴近 README 示例；TextRenderer 的段落容器始终是 **`div`**。语义与样式等价目的一致。
- **`urlSafety`**：主工程若包含 `mailto:` 等协议，与仅 `http/https` 的 renderer 可能不完全相同；以 `src/utils/urlSafety.ts` 为准。

若需逐行对照实现，请以 **`renderTextBody` 主循环** 与 **`runStylesToCssString`** 分别对应 TextRenderer 中的 **段落 `paraDiv` 段** 与 **run 的 `element.style` 段**。

## 一致性核对摘要（对照 `TextRenderer.ts`）

- **合并顺序**：段落七级与 TextRenderer 中 `merged` 构建顺序一致（defaultTextStyle → category txStyles → master ph → layout ph → shape lstStyle → pPr）。
- **Run**：`defRPr` → `rPr`，再执行 lstStyle 字色回退；`mergeRunProps` 与 renderer 同源（颜色来自 `solidFill` / `gradFill`，无单独 `rPr` 下直接 `schemeClr` 分支）。
- **normAutofit**：`fontScale`、`lnSpcReduction` 作用于行距与 run 字号。
- **输出差异**：仅「写 DOM」与「拼 HTML 字符串」不同；段落用 `<p>`/`<div>` 与 renderer 全 `div` 的差异见上文。
