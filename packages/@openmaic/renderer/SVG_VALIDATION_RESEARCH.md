# Issue 1851：SVG path 验证与恢复调研

调研日期：2026-10-14。本文记录方案依据与边界；具体实现和默认阈值以代码为准。问题范围来自 [issue 1851](https://github.com/THU-MAIC/OpenMAIC/issues/1851)。本仓已有 renderer `DESIGN.md`，因此将调研放在同一包下。

## 建议

继续复用 `svg-pathdata`，在它之前增加完整消费输入的语法检查，在它之后检查解析结果和缩放结果的有限性。将这些规则做成不依赖 React、DOM、应用导出代码的共享核心；生成、编辑、后续白板工具调用同一接口。纯 DSL 包保持零运行时依赖。

验证器负责证明「语法正确、数值可计算、资源消耗受限」，不负责证明「这几个图形准确表达了题意」或「画面好看」。新写入严格拒绝错误；历史读取与 PPT 导入保持独立策略；渲染器始终保证终止。

## 现成包能解决哪些问题

| 包 / 项目 | 一手资料中的能力 | 适用范围与不足 |
| --- | --- | --- |
| `svg-pathdata` v8 | path 命令解析、流式解析、相对转绝对、变换和 bounds；`finish()` 检查未结束命令 [1][2] | 已有依赖，可继续复用；没有产品级长度、复杂度、坐标上限，且解析成功不等于完整语法合法。 |
| `svgpath` | 显式索引、命令参数表、单字符 arc flag、位置错误；要求初始 `M/m` [3] | 很适合参考扫描器设计，但接受非标准 `R/r`、更广的空白，并拒绝 `01` 这样的前导零数字；不能直接当严格标准验证器。数值用 `parseFloat`，仍需有限性检查。 |
| `svg-path-parser` | 基于 PEG 的完整 path grammar，支持隐式重复、弧、相对命令；返回结构化命令 [4] | 可作为独立对照测试 oracle；数字通过乘 1 转换，仍允许数值溢出；另引入解析器会增加维护与语义差异。 |
| SVGO | XML 转 AST，解析错误含行列和上下文；随后运行优化插件 [5] | 成熟 SVG 文档处理实践，适合借鉴结构化错误。它是优化器，不能替代 path 输入验证，也不应为了校验重写用户几何。其 XML parser 当前用 `sax`。 |
| `saxes` | 校验 XML well-formedness、报告位置，错误后不应依赖继续产生的结构 [6] | 处理完整 `<svg>` 文档才有用；不验证 `d` 属性的几何语法，也不提供业务资源上限。 |
| DOMPurify | 对 HTML / MathML / SVG 做 XSS 清洗，服务端需要 DOM [7] | 解决 markup 安全边界；不能证明 path 参数、坐标范围、bounds 合法。`PPTShapeElement.path` 是 `d` 属性值，不应把 markup sanitizer 当 path validator。 |

其中最值得借鉴的成熟实现是 Chromium/Blink：source 独立负责扫描并记录第一处错误位置，consumer 负责几何处理；首命令必须是 `M/m`；`Z` 后禁止隐式数字续写；遇到 unknown/error segment 立即返回失败 [8][9]。它把解析与绘图分开，适合我们的共享核心与 renderer 分层。

## 已有解析器的实测边界

以下结果由 worktree 中现有 `svg-pathdata` v8 实际执行取得，并与固定版本源代码对照 [2]：

| 输入 | v8 行为 | 我们应如何处理 |
| --- | --- | --- |
| `M 0 0 Z 1 1` | 成功返回 `M,Z`，丢弃尾部数字 | 明确报尾部非法数据，位置指向 `Z` 后第一处数字。 |
| `L 0 0` | 接受 | 拒绝：标准路径必须从 `M/m` 开始 [10]。 |
| `M 1e999 0` | `x` 为 `Infinity` | 拒绝：`Number.isFinite`；JSON 序列化会把 `Infinity` 变成 `null`，调试时要注意。 |
| `M 0 0 A 1 1 0010 10` | 接受，解释为 rotation=0、flags=0/1、endpoint=(0,10) | 标准 grammar 要求 rotation 与首个 flag 之间有 `comma_wsp`，严格写入应拒绝 [10]。 |
| `M 0 0 A 1 1 0 0110 10` | 接受 | 必须保留：两个 flags 及后续坐标可以紧邻 [10]。 |
| `M 0 0 A 1 1 0 2 0 10 10` | 拒绝 flag=2 | 可复用已有检查，同时给调用者统一错误结构。 |
| `M,0 0`、`M 0 0,,L 1 1`、`M 0 0,` | 拒绝 | 不要把现有解析器描述成完全不校验分隔符。 |
| `M 01 2` | 接受 | 保留：标准的 `digit+` 允许前导零；`svgpath` 在此更严格 [3][10]。 |
| `M 0 0 A -1 1 0 0 0 10 10` | 拒绝负半径 | 明确兼容性政策：SVG 2 渲染算法会取半径绝对值，而 v8 拒绝 [2][11]。不要悄悄修改新输入；历史导入如果需要宽容，应由专门适配器决定。 |

这也说明「parse 后重新 encode 比较字符串」不是可靠的完整性校验：编码会合法改变空白、数字格式和隐式命令，不能简单比较；丢失的尾部也可能被规范化掩盖。

## 验证器设计

建议暴露 path 校验和 shape geometry 校验两层纯函数，返回判别联合：成功返回可复用的解析结果；失败返回 `{ code, field, position?, message }`。field 至少能表达 `path`、`viewBox[0]`、`width`。错误位置采用 JavaScript 字符串的零基索引，并在 API 文档写明。

顺序应为：

1. 类型和 path 字符长度。超限在任何 tokenize / parse / bounds 操作之前失败。
2. 单次扫描全部输入，保留命令状态、参数位置、分隔符和 arc flag 状态；每次循环必须消费字符或返回错误。支持 `M/L/H/V/C/S/Q/T/A/Z` 大小写、隐式参数重复、`M` 后重复坐标转 `L`、科学计数法，以及 `M100-200`、`M0.6.5` 等标准紧凑写法 [10]。
3. 复用 `svg-pathdata` 得到命令，检查参数有限性、命令数与参数数量。命令数量应计算展开后的隐式重复，不能只数命令字母。
4. 检查相对坐标累计、控制点以及绝对化结果；`1e308` 本身有限，不代表相加、乘法或 bounds 计算仍有限。
5. 检查 `viewBox` 两个分量和绘图宽高有限且大于零；验证 `width / viewBox[0]`、`height / viewBox[1]`，以及实际使用的缩放乘积仍有限。应用当前二元 `viewBox` 是自有 DSL 的尺寸，不是标准 SVG 四元 `viewBox` [12]。

长度、命令数、坐标量级应是 caller 配置的 policy，有统一默认值及命名覆盖。AI 新生成通常需要较低上限；导入复杂 PPT 应有独立回归样本和宽松额度。具体阈值需要以真实课件分布和性能测量确定，不能宣称某个任意数值是 SVG 标准上限。

不能要求路径一定闭合、面积非零或 bbox 宽高非零：开放曲线、水平线、单点、零半径弧都可能合法。空 path 是标准允许的不可见路径 [10]；产品若要求新建图形可见，应额外设置非空业务政策，而不是混淆语法错误。零 bounds 也不能表示「解析失败」；成功的退化几何与错误必须有不同结果。

## 当前 slide 出错会有什么表现

浏览器对非法 `d` 的标准恢复是绘制到首个出错命令之前；如果一个隐式重复命令部分完整，会保留其最后一个完整 segment，例如 `M10,10 L20,20,30` 仍画到 `(20,20)` [13]。因此常见表现是少了一段边、局部图形或空白，而不是天然的 JavaScript 异常。浏览器是否在控制台输出诊断不等于业务接口能够收到结构化错误。

当前 renderer 还在 React render 中同步运行自己的 `pathCoordBBox`。其 `Z` 分支不消费数字，`M 0 0 Z 1 1` 会反复进入同一位置。这里的问题发生在浏览器真正绘制 `<path>` 之前，会阻塞渲染线程；React ErrorBoundary 无法捕获一个从不返回的循环 [12]。issue 中的隔离复现证实的是 SDK bounds parser，不应扩大成所有白板入口已经冻结 [14]。

原 bbox 扫描器还把相对命令值当绝对坐标、只记录弧终点。它用于扩展 SVG viewport 以避免 PNG capture 裁切；错误 bbox 可能使预览与截图/导出不一致 [12]。验证器能拦非法输入，但不能自动修正合法路径的错误 bounds 算法；两者需要分别处理。

应用已有导出层会把解析失败转成空点集、把非法 bounds 转成零范围。这有助于单个坏 shape 不拖垮整个导出，却会掩盖错误和产生缺图 [15]。新写入不能复用这些宽容返回值作为成功判据。

## 优雅恢复建议

| 场景 | 建议恢复 |
| --- | --- |
| AI 生成新 shape | 将精确 field / position / reason 回传给模型，有限次数修复该 shape；验证失败直接丢弃该 shape 及附带文字，保留 slide 其他合法元素。不要无限重试整个课程。 |
| 编辑已有 shape | 先校验完整 candidate，再提交；失败不覆盖上一次合法 geometry，不新增错误撤销历史。工具返回结构化错误，便于模型只修出错字段。 |
| 历史读取、回放 | 加载历史记录，不因新写入额度而拒绝整页；渲染侧保证所有扫描终止。对坏 shape 使用安全的 fallback geometry / 隐藏坏 path，保留其布局、文字和其余 slide。原始历史数据保持可诊断。 |
| 复杂 PPT 导入 | 使用独立策略，保留可表示的合法路径；超新生成额度不代表导入错误。对真正无法处理的元素报告告警并局部降级。 |
| PPTX / PNG 导出 | 单元素失败隔离；返回或记录元素级 warning，避免用户把「导出成功」误解为「全部几何保真」。 |

生成阶段不自动截取合法前缀、替换成矩形或转换为 text，以免改变教学语义、丢失样式或绕过尺寸限额。验证失败时形状与附带文字一并移除，保留其他合法元素。历史渲染的容错独立处理，原记录和文字 overlay 继续保留。

写入校验与历史渲染防护需要同时存在。即使新入口全部加了 validator，历史数据、第三方导入和直接传入 SDK 的对象依然可能绕过它。渲染侧安全兜底也应是局部、可终止的，不重写持久化内容。

## 验证与未解决边界

回归应覆盖合法紧凑语法、大小写、科学计数、隐式重复、开放/退化路径、连续子路径、弧；反例覆盖 `Z` 尾数字、漏参数、错误 flags、分隔符、XML markup、数值及变换溢出、长度和命令额度。SDK 无限循环回归必须在独立 worker / 子进程中加 timeout，测试 runner 内普通超时无法打断同步死循环。

限额不代表能保证任意浏览器或导出库的渲染耗时；复杂滤镜、完整 SVG markup 和外部资源不属于本 issue 的 path 验证范围。语义正确性、图形间关系、精确弧 bounds 及导出保真仍需独立应用测试。本文核查了源代码与解析器行为，没有声称对每一种浏览器完成截图实测。

## 一手来源

1. svg-pathdata v8 文档：https://github.com/nfroidure/svg-pathdata/blob/v8.0.0/README.md
2. svg-pathdata v8 parser：https://github.com/nfroidure/svg-pathdata/blob/v8.0.0/src/SVGPathDataParser.ts
3. svgpath parser：https://github.com/fontello/svgpath/blob/master/lib/path_parse.js
4. svg-path-parser PEG grammar：https://github.com/hughsk/svg-path-parser/blob/master/grammar.peg
5. SVGO XML parser：https://github.com/svg/svgo/blob/main/lib/parser.js
6. saxes 范围、错误与限额说明：https://github.com/lddubeau/saxes/blob/master/README.md
7. DOMPurify 安全职责与服务端 DOM 依赖：https://github.com/cure53/DOMPurify/blob/main/README.md
8. Blink parse loop：https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/svg/svg_path_parser.h
9. Blink source 状态机：https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/svg/svg_path_string_source.cc
10. SVG 2 path grammar：https://www.w3.org/TR/SVG2/paths.html#PathDataBNF
11. SVG 2 弧退化及半径修正：https://www.w3.org/TR/SVG2/paths.html#ArcOutOfRangeParameters
12. 当前问题基线的 SDK renderer：https://github.com/THU-MAIC/OpenMAIC/blob/6a84dbeb/packages/@openmaic/renderer/src/elements/shape/BaseShapeElement.tsx
13. SVG 2 path 错误恢复：https://www.w3.org/TR/SVG2/paths.html#PathDataErrorHandling
14. 问题与隔离复现范围：https://github.com/THU-MAIC/OpenMAIC/issues/1851
15. 当前问题基线的导出 parser：https://github.com/THU-MAIC/OpenMAIC/blob/6a84dbeb/lib/export/svg-path-parser.ts

## 本分支落地

共享模块位于 `@openmaic/geometry`，复用 `svg-pathdata@8`；DSL 未增加依赖。已接入生成、SDK 编辑事务、应用编辑操作、agent 完整 candidate 校验、SDK / 应用只读渲染以及导出容错。白板自定义 path 工具后续可直接调用 `validateShapeGeometry`，本分支不增加白板工具参数。

默认新输入额度为 100,000 UTF-16 字符、10,000 展开命令和 1,000,000 坐标量级。历史渲染使用独立的 2,000,000 字符、200,000 命令和 1e12 数值额度。它们是可配置的初始产品政策，不是 SVG 标准，也尚未按全量课件分布调优。额度不参与历史读取、撤销或重做。

错误编辑保留原快照；生成坏 shape 一律丢弃整个元素，包括附带文字，不转为 text。当前未增加模型自动修复轮次。历史渲染跳过错误 path，保留 label、位置和原始数据，并通过 `data-shape-geometry-error` 暴露局部诊断标记。导出继续按已有契约返回空几何，不将其当作新写入成功。

SDK 旧 bounds 手写扫描器已移除，改用共享模块的保守控制点 bounds。弧在局部单位坐标中转换，避免依赖的绝对半径 epsilon 把微小合法弧当直线；超出依赖数值精度的极端轴比显式报错。隔离 worker 复现了旧实现的 500 ms 超时；SDK 渲染回归同样设有 500 ms 防护。复杂导入回归包含 ellipse、gear6、circularArrow、arc、pie、leftBrace 和流程图 connector。
