# 🎨 pptxtojson

> ⚠️ **Browser-only.** This package parses `.pptx` in the browser and depends on
> DOM APIs (`XMLHttpRequest`, `DOMMatrix`, `Path2D`, via a browser-targeted
> pdf.js build). It is built for browser / bundler (webpack, Vite, Next client)
> environments — importing it in a pure Node.js process throws at load. Use it
> from client code, not from a Node server runtime.

<p>
    <a href="https://www.github.com/pipipi-pikachu/pptxtojson/stargazers" target="_black"><img src="https://img.shields.io/github/stars/pipipi-pikachu/pptxtojson?logo=github" alt="stars" /></a>
    <a href="https://www.github.com/pipipi-pikachu/pptxtojson/network/members" target="_black"><img src="https://img.shields.io/github/forks/pipipi-pikachu/pptxtojson?logo=github" alt="forks" /></a>
    <a href="https://www.github.com/pipipi-pikachu/pptxtojson/blob/master/LICENSE" target="_black"><img src="https://img.shields.io/github/license/pipipi-pikachu/pptxtojson?logo=github" alt="license" /></a>
    <a href="https://github.com/pipipi-pikachu/pptxtojson/issues" target="_black"><img src="https://img.shields.io/github/issues-closed/pipipi-pikachu/pptxtojson?logo=github" alt="issue"></a>
    <a href="https://gitee.com/pptist/pptxtojson" target="_black"><img src="https://gitee.com/pptist/pptxtojson/badge/star.svg?version=latest" alt="gitee"></a>
    <a href="https://gitcode.com/pipipi-pikachu/pptxtojson" target="_black"><img src="https://gitcode.com/pipipi-pikachu/pptxtojson/star/badge.svg" alt="gitcode"></a>
</p>

一个运行在浏览器中，可以将 .pptx 文件转为可读的 JSON 数据的 JavaScript 库。

**实现说明**：主入口为 TypeScript 实现（`src/`），构建产物为 `dist/`；输出 JSON 格式与文档及原示例一致。原 JavaScript 实现位于 `src1/`，仅作输出格式与逻辑参考，不参与构建。

**OpenMAIC 扩展**：在 `parse()`（PPTX → 中间 JSON）之上新增了完整的 import pipeline —— `importPptx()` 直接吃 `.pptx` 文件、吐 OpenMAIC 画布需要的 `Slide[]`，并可选地把所有 base64 图片 / blob 媒体转交给你提供的 OSS 上传函数。详见下方「🚀 进阶用法」。

> 与其他的pptx文件解析工具的最大区别在于：
> 1. 直接运行在浏览器端；
> 2. 解析结果是**可读**的 JSON 数据，而不仅仅是把 XML 文件内容原样翻译成难以理解的 JSON。

在线DEMO：https://pipipi-pikachu.github.io/pptxtojson/

> 国内镜像（定期同步）：[Gitee](https://gitee.com/pptist/pptxtojson)、[GitCode](https://gitcode.com/pipipi-pikachu/pptxtojson)

# 🎯 注意事项
### ⚒️ 使用场景
本仓库诞生于项目 [PPTist](https://github.com/pipipi-pikachu/PPTist) ，希望为其“导入 .pptx 文件功能”提供一个参考示例。不过就目前来说，解析出来的PPT信息与源文件在样式上还是存在差异。

但如果你只是需要提取PPT文件的文本内容、媒体资源信息、结构信息等，或者对排版/样式精准度没有特别高的要求，那么 pptxtojson 可能会对你有帮助。

### 📏 长度值单位
输出的JSON中，所有数值长度值单位都为`pt`（point）
> 注意：在0.x版本中，所有输出的长度值单位都是px（像素）

# 🔨安装
```
npm install pptxtojson
```

# 💿用法

### 浏览器
```html
<input type="file" accept="application/vnd.openxmlformats-officedocument.presentationml.presentation"/>
```

```javascript
import { parse } from 'pptxtojson'

document.querySelector('input').addEventListener('change', evt => {
	const file = evt.target.files[0]
	
	const reader = new FileReader()
	reader.onload = async e => {
		const json = await parse(e.target.result)
		console.log(json)
	}
	reader.readAsArrayBuffer(file)
})
```

### Node.js(实验性，1.5.0以上版本)
```javascript
const pptxtojson = require('pptxtojson/dist/index.cjs')
const fs = require('fs')

async function func() {
  const buffer = fs.readFileSync('test.pptx')

  const json = await pptxtojson.parse(buffer.buffer)
  console.log(json)
}

func()
```

# 🚀 进阶用法：PPTX → OpenMAIC 画布 `Slide[]`

`parse()` 只完成「PPTX → 可读 JSON」这一步，元素的字段还是 PPT 语义（`type: 'text' | 'shape' | 'image' …`、单位 `pt`、媒体是 base64 / `blob:` URL）。

如果你需要的最终产物是 **OpenMAIC 画布直接可渲染的 `Slide[]`**（`PPTTextElement` / `PPTShapeElement` / `PPTImageElement` 等、单位 `px`、媒体替换为 OSS URL），用 `importPptx()`。

## 🔑 API 一览

| 导出 | 类型 | 用途 |
|------|------|------|
| `importPptx(input, options?)` | `(File \| Blob \| ArrayBuffer, ImportPptxOptions?) => Promise<Slide[]>` | 一站式：`.pptx` → `Slide[]`，等所有上传 settle 后再 resolve |
| `parsedToSlides(json, options?)` | `(Output, ImportPptxOptions?) => Promise<Slide[]>` | 只做「中间 JSON → `Slide[]`」，给已经用 `parse()` 拿到 JSON 的场景 |
| `OssUpload` | `(blob: Blob, filename: string, dir?: string) => Promise<string>` | 上传回调签名 |
| `ImportPptxOptions` | `{ upload?: OssUpload }` | 选项对象 |
| `CanvasSlide` | OpenMAIC `Slide` 类型 | 用于消费方做类型注解 |

`importPptx` 内部就是 `parse(buffer, { mediaMode: 'base64' })` + `parsedToSlides(...)`，两者任选其一即可。

## 🧩 完整签名

```ts
import {
  importPptx,
  parsedToSlides,
  type OssUpload,
  type ImportPptxOptions,
  type CanvasSlide,
} from '@openmaic/importer';

export type OssUpload = (
  blob: Blob,
  filename: string,
  dir?: string,
) => Promise<string>;

export interface ImportPptxOptions {
  /**
   * 上传媒体（图片 / 音频 / 视频）到远程存储并返回公网 URL。
   * - 提供：所有 base64 图片会先转成 Blob，再调用此函数，URL 写回 slide。
   * - 不提供：图片保留 base64 data URL；音视频保留临时 `blob:` URL（仅当前 tab 有效）。
   */
  upload?: OssUpload;
}

export function importPptx(
  input: File | Blob | ArrayBuffer,
  options?: ImportPptxOptions,
): Promise<CanvasSlide[]>;

export function parsedToSlides(
  json: Output,
  options?: ImportPptxOptions,
): Promise<CanvasSlide[]>;
```

## 📦 用法

### 1. 不传 `upload` —— 本地预览 / 调试

媒体留在内存，slide 可以直接在当前 tab 里渲染，但**刷新就失效**（音视频）/ **JSON 体积大**（图片）。

```ts
import { importPptx } from '@openmaic/importer';

const slides = await importPptx(file);
// slides[*].elements 里的 image.src 还是 data:image/png;base64,…
// audio/video.src 是 blob:http://… URL
```

### 2. 传 `upload` —— 生产场景

把媒体上传到你自己的 OSS / classroom-media / S3 / 任意存储，slide 里只剩 URL：

```ts
import { importPptx, type OssUpload } from '@openmaic/importer';

const upload: OssUpload = async (blob, filename, dir) => {
  const form = new FormData();
  form.append('file', blob, filename);
  form.append('dir', dir ?? 'pptx-import');

  const res = await fetch('/api/upload', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  const { url } = await res.json();
  return url; // ← 必须返回最终可访问 URL
};

const slides = await importPptx(file, { upload });
// 此时 slides[*].elements 里的 src 全是 OSS URL
```

### 3. 已经用 `parse()` 拿到 JSON 时

```ts
import { parse, parsedToSlides } from '@openmaic/importer';

const json = await parse(buffer, { mediaMode: 'base64' });
const slides = await parsedToSlides(json, { upload });
```

> ⚠️ 必须用 `mediaMode: 'base64'`。`blob` 模式产出的 URL 只在当前 tab 有效，无法上传后跨页面使用。

## 📞 `upload` 回调被调用的时机

| 元素类型 | 源数据 | filename 示例 | dir |
|---------|--------|---------------|-----|
| 背景图片 | base64 → Blob | `background_<timestamp>.png` | `a2m` |
| 图片元素 | base64 → Blob | `image_<timestamp>.png` | `a2m` |
| 数学公式渲染图 | base64 → Blob | `math_<timestamp>.png` | `a2m` |
| 形状的图案填充 | base64 → Blob | `pattern_<timestamp>.png` | `a2m` |
| 音频 | 直接是 Blob | `audio_<timestamp>.mp3` | `a2m/audio` |
| 视频 | 直接是 Blob | `video_<timestamp>.mp4` | `a2m/video` |

并发：内部用 6 路并发上传图片，避免一次性打满网络。

## 💥 错误处理

- **单个媒体上传失败** → transform 内部 `.catch` 吞掉错误（控制台 `console.error`），该元素的 `src` 仍是原始 base64 / 空字符串。整体 import **不会失败**。
- **`parse()` 解析失败**（坏文件等）→ `importPptx` 直接 `throw`，调用方自己 `try/catch`。
- 内部用 `Promise.allSettled` 等所有上传 settle 后才 resolve，调用方拿到的 `Slide[]` 不需要再 await 任何东西。

## ⚠️ 当前限制

| 模块 | 状态 | 影响 |
|------|------|------|
| 字体白名单（`resolveFont`） | **stub，透传** | 中文字体保留原名，浏览器找不到字体时会回退到默认。后续可移植 PPTist 字体替换逻辑。 |
| 视频编码检测（`videoCodec`） | **stub，永远视为支持** | HEVC 等浏览器不支持的编码会变成坏的 `<video>`，而不是降级到占位图标。 |
| SVG path bbox（`svgPathParser`） | 自实现 tokenizer | 标准命令（M L H V C S Q T A Z 大小写）都覆盖；弧线 bbox 用端点近似，可能略小。 |

## 🧪 在 Next.js (Turbopack) 里用

`maic-importer` 源码依赖 `pdfjs-dist`，其动态 `require()` 模式会被 Turbopack 拒绝。OpenMAIC 的做法：

1. `pnpm run build` 把整个包（含 importPptx）打成 `dist/`。
2. `scripts/sync-maic-importer.mjs` 把 `dist/` 复制到 `public/vendor/maic-importer/`。
3. 在客户端组件里用**静态 URL 动态 import**，bundler 完全看不到：

```ts
import type * as PptxtojsonPro from '@openmaic/importer';

const mod = (await import(
  /* webpackIgnore: true */
  /* turbopackIgnore: true */
  /* @vite-ignore */
  '/vendor/maic-importer/index.js'
)) as typeof PptxtojsonPro;

const slides = await mod.importPptx(file, { upload });
```

类型仍走 workspace 包，IntelliSense 不丢。

参考：`lib/import/use-import-pptx.ts`。

### ⚠️ 部署依赖（必读）

`public/vendor/maic-importer/` 是 **gitignored 的构建产物**，不进仓库，由 `postinstall`
现生成（`pnpm --filter @openmaic/importer build` + `node scripts/sync-maic-importer.mjs`）。
因此部署流水线**必须执行 `postinstall`**（或显式跑这两步），否则运行时
`/vendor/maic-importer/index.js` 会 404，PPTX 导入功能失效。

两道防护已就位：

- **构建期断言**：根 `build` 脚本前置 `node scripts/assert-vendor-maic-importer.mjs`，
  若 vendor 产物缺失则**构建直接失败**并给出修复提示，避免把必崩版本部署上线。
- **运行期守卫**：`use-import-pptx.ts` 在动态 import 前先 `HEAD` 预检该 URL，
  404 时抛出明确错误并提示 `import.error.parserUnavailable`，而不是把 404 HTML
  当 JS 解析出诡异的 `SyntaxError`。

> 另注：`git pull` 后若未重新 `pnpm install`，workspace 类型会更新但 URL 加载的
> 仍是旧 `dist`，二者可能静默漂移——拉取后请重新安装。

---

### 输出示例（`parse()`，未走 import pipeline）
```javascript
{
	"slides": [
		{
			"fill": {
				"type": "color",
				"value": "#FF0000"
			},
			"elements": [
				{
					"left":	0,
					"top": 0,
					"width": 72,
					"height":	72,
					"borderColor": "#1F4E79",
					"borderWidth": 1,
					"borderType": "solid",
					"borderStrokeDasharray": 0,
					"fill": {
						"type": "color",
						"value": "#FF0000"
					},
					"content": "<p style=\"text-align: center;\"><span style=\"font-size: 18pt;font-family: Calibri;\">TEST</span></p>",
					"isFlipV": false,
					"isFlipH": false,
					"rotate": 0,
					"vAlign": "mid",
					"name": "矩形 1",
					"type": "shape",
					"shapType": "rect"
				},
				// more...
			],
			"layoutElements": [
				// more...
			],
			"note": "演讲者备注内容..."
		},
		// more...
	],
	"themeColors": ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'],
	"size": {
		"width": 960,
		"height": 540
	}
}
```

# 📕 完整功能支持

- 幻灯片主题色 `themeColors`

- 幻灯片尺寸 `size`
	- 宽度 `width`
	- 高度 `height`

- 幻灯片页面 `slides`

	- 页面备注 `note`

	- 页面背景填充（颜色、图片、渐变、图案） `fill`
		- 纯色填充 `type='color'`
		- 图片填充 `type='image'`
		- 渐变填充 `type='gradient'`
		- 图案填充 `type='pattern'`

	- 页面切换动画 `transition`
		- 类型 `type`
		- 持续时间 `duration`
		- 方向 `direction`

	- 页面内元素 `elements` / 母版元素 `layoutElements`
		- 文字
			- 类型 `type='text'`
			- 水平坐标 `left`
			- 垂直坐标 `top`
			- 宽度 `width`
			- 高度 `height`
			- 边框颜色 `borderColor`
			- 边框宽度 `borderWidth`
			- 边框类型（实线、点线、虚线） `borderType`
			- 非实线边框样式 `borderStrokeDasharray`
			- 阴影 `shadow`
			- 填充（颜色、图片、渐变、图案） `fill`
			- 内容文字（HTML富文本：字体、字号、颜色、渐变、下划线、删除线、斜体、加粗、阴影、角标、超链接） `content`
			- 垂直翻转 `isFlipV`
			- 水平翻转 `isFlipH`
			- 旋转角度 `rotate`
			- 垂直对齐方向 `vAlign`
			- 是否为竖向文本 `isVertical`
			- 元素名 `name`
			- 自动调整大小 `autoFit`
				- 类型 `type`
					- `shape`：文本框高度会根据文本内容自动调整
					- `text`：文本框大小固定，字号会自动缩放以适应文本框（注：autoFit不存在时，也会固定文本框大小，但字号不会缩放）
				- 字体缩放比例（type='text'专有，默认为1） `fontScale`
			- 超链接 `link`

		- 图片
			- 类型 `type='image'`
			- 水平坐标 `left`
			- 垂直坐标 `top`
			- 宽度 `width`
			- 高度 `height`
			- 边框颜色 `borderColor`
			- 边框宽度 `borderWidth`
			- 边框类型（实线、点线、虚线） `borderType`
			- 非实线边框样式 `borderStrokeDasharray`
			- 裁剪形状 `geom`
			- 裁剪范围 `rect`
			- 图片地址（base64） `src`
			- 旋转角度 `rotate`
			- 滤镜 `filters`
			- 超链接 `link`

		- 形状
			- 类型 `type='shape'`
			- 水平坐标 `left`
			- 垂直坐标 `top`
			- 宽度 `width`
			- 高度 `height`
			- 边框颜色 `borderColor`
			- 边框宽度 `borderWidth`
			- 边框类型（实线、点线、虚线） `borderType`
			- 非实线边框样式 `borderStrokeDasharray`
			- 阴影 `shadow`
			- 填充（颜色、图片、渐变、图案） `fill`
			- 内容文字（HTML富文本，与文字元素一致） `content`
			- 垂直翻转 `isFlipV`
			- 水平翻转 `isFlipH`
			- 旋转角度 `rotate`
			- 形状类型 `shapType`
			- 垂直对齐方向 `vAlign`
			- 形状路径 `path`
			- 形状调整参数 `keypoints`
			- 元素名 `name`
			- 自动调整大小 `autoFit`
			- 超链接 `link`

		- 表格
			- 类型 `type='table'`
			- 水平坐标 `left`
			- 垂直坐标 `top`
			- 宽度 `width`
			- 高度 `height`
			- 边框（4边） `borders`
			- 表格数据 `data`
			- 行高 `rowHeights`
			- 列宽 `colWidths`

		- 图表
			- 类型 `type='chart'`
			- 水平坐标 `left`
			- 垂直坐标 `top`
			- 宽度 `width`
			- 高度 `height`
			- 图表数据 `data`
			- 图表主题色 `colors`
			- 图表类型 `chartType`
			- 柱状图方向 `barDir`
			- 是否带数据标记 `marker`
			- 环形图尺寸 `holeSize`
			- 分组模式 `grouping`
			- 图表样式 `style`

		- 视频
			- 类型 `type='video'`
			- 水平坐标 `left`
			- 垂直坐标 `top`
			- 宽度 `width`
			- 高度 `height`
			- 视频blob `blob`
			- 视频src `src`

		- 音频
			- 类型 `type='audio'`
			- 水平坐标 `left`
			- 垂直坐标 `top`
			- 宽度 `width`
			- 高度 `height`
			- 音频blob `blob`

		- 公式
			- 类型 `type='math'`
			- 水平坐标 `left`
			- 垂直坐标 `top`
			- 宽度 `width`
			- 高度 `height`
			- 公式图片 `picBase64`
			- LaTeX表达式（仅支持常见结构） `latex`
			- 文本（文本和公式混排时存在） `text`

		- Smart图
			- 类型 `type='diagram'`
			- 水平坐标 `left`
			- 垂直坐标 `top`
			- 宽度 `width`
			- 高度 `height`
			- 子元素集合 `elements`
			- 文本列表（Smart图中的文字内容清单，仅在elements无法解析时存在） `textList`

		- 多元素组合
			- 类型 `type='group'`
			- 水平坐标 `left`
			- 垂直坐标 `top`
			- 宽度 `width`
			- 高度 `height`
			- 子元素集合 `elements`

### 更多类型请参考 👇
[https://github.com/pipipi-pikachu/pptxtojson/blob/master/dist/index.d.ts](https://github.com/pipipi-pikachu/pptxtojson/blob/master/dist/index.d.ts)

# 🙏 感谢
本仓库大量参考了 [PPTX2HTML](https://github.com/g21589/PPTX2HTML) 和 [PPTXjs](https://github.com/meshesha/PPTXjs) 的实现。
> 与它们不同的是：PPTX2HTML 和 PPTXjs 是将PPT文件转换为能够运行的 HTML 页面，而 pptxtojson 做的是将PPT文件转换为干净的 JSON 数据，且在原有基础上进行了大量优化补充（包括代码质量和提取信息的完整度和准确度）。

# 📄 开源协议
MIT License | Copyright © 2020-PRESENT [pipipi-pikachu](https://github.com/pipipi-pikachu)