# PDF 解析系统

提供统一接口支持多种 PDF 解析提供商。

## 支持的提供商

### 1. unpdf (内置)

- **成本**: 免费，内置
- **特性**: 基础文本提取、图片提取
- **要求**: 无
- **使用**: 直接上传 PDF 文件

### 2. MinerU (本地部署)

- **成本**: 免费（需要自己部署）
- **特性**:
  - 高级文本提取（保留 Markdown 布局）
  - 表格识别
  - 公式提取（LaTeX）
  - 更好的 OCR 支持
  - 多种输出格式（markdown, JSON, docx, html, latex）
- **要求**:
  - 部署 MinerU 服务（Docker 或源码）
  - 配置服务器地址
- **优势**: 数据隐私、无文件大小限制

## 快速开始

### 部署 MinerU（可选）

```bash
# Docker 部署（推荐）
docker pull opendatalab/mineru:latest
docker run -d --name mineru -p 8080:8080 opendatalab/mineru:latest

# 验证
curl http://localhost:8080/api/health
```

### API 使用

#### 使用 unpdf（文件上传）

```typescript
const formData = new FormData();
formData.append('pdf', pdfFile);
formData.append('providerId', 'unpdf');

const response = await fetch('/api/parse-pdf', {
  method: 'POST',
  body: formData,
});

const result = await response.json();
// result.data: ParsedPdfContent
```

#### 使用 MinerU（本地服务）

```typescript
const formData = new FormData();
formData.append('pdf', pdfFile);
formData.append('providerId', 'mineru');
formData.append('baseUrl', 'http://localhost:8080');

const response = await fetch('/api/parse-pdf', {
  method: 'POST',
  body: formData,
});

const result = await response.json();
// result.data: ParsedPdfContent with imageMapping
```

## 响应格式

```typescript
interface ParsedPdfContent {
  text: string; // 提取的文本（MinerU 为 Markdown）
  images: string[]; // Base64 图片数组

  // 扩展特性（MinerU）
  tables?: Array<{
    page: number;
    data: string[][];
    caption?: string;
  }>;

  formulas?: Array<{
    page: number;
    latex: string;
    position?: { x: number; y: number; width: number; height: number };
  }>;

  layout?: Array<{
    page: number;
    type: 'title' | 'text' | 'image' | 'table' | 'formula';
    content: string;
    position?: { x: number; y: number; width: number; height: number };
  }>;

  metadata?: {
    pageCount: number;
    parser: 'unpdf' | 'mineru';
    fileName?: string;
    fileSize?: number;
    processingTime?: number;

    // 用于内容生成流程（MinerU）
    imageMapping?: Record<string, string>; // img_1 -> base64 URL
    pdfImages?: Array<{
      id: string; // img_1, img_2, etc.
      src: string; // base64 data URL
      pageNumber: number; // PDF 页码
      description?: string; // 图片描述
    }>;
  };
}
```

## 与内容生成集成

MinerU 解析器与内容生成流程无缝集成：

```typescript
// 1. 解析 PDF
const parseResult = await parsePDF(
  {
    providerId: 'mineru',
    baseUrl: 'http://localhost:8080',
  },
  buffer,
);

// 2. 提取数据
const pdfText = parseResult.text; // Markdown（含 img_1 引用）
const pdfImages = parseResult.metadata.pdfImages; // 图片数组
const imageMapping = parseResult.metadata.imageMapping; // 图片映射

// 3. 生成场景大纲
await generateSceneOutlinesFromRequirements(
  requirements,
  pdfText, // Markdown 内容
  pdfImages, // 带页码的图片
  aiCall,
);

// 4. 生成场景（含图片）
await buildSceneFromOutline(
  outline,
  aiCall,
  stageId,
  assignedImages, // 从 pdfImages 筛选
  imageMapping, // 用于解析 img_1 到实际 URL
);
```

## 图片处理流程

MinerU 的图片处理：

1. **提取**: PDF → MinerU → Markdown + 图片
2. **转换**: `![alt](images/img_1.png)` → `![alt](img_1)`
3. **映射**: 创建 `{ "img_1": "data:image/png;base64,..." }`
4. **生成**: AI 使用 `img_1` 引用生成幻灯片
5. **解析**: `resolveImageIds()` 替换为实际 URL
6. **渲染**: 幻灯片显示图片

## 配置

### 全局设置

```typescript
import { useSettingsStore } from '@/lib/store/settings';

useSettingsStore.setState({
  pdfProviderId: 'mineru',
  pdfProvidersConfig: {
    mineru: {
      baseUrl: 'http://localhost:8080',
      apiKey: 'optional-if-needed',
    },
  },
});
```

### 请求级配置

```typescript
// 在 API 调用时覆盖全局设置
formData.append('providerId', 'mineru');
formData.append('baseUrl', 'http://your-server:8080');
formData.append('apiKey', 'optional');
```

## 添加新的提供商

### 1. 定义提供商

`lib/pdf/constants.ts`:

```typescript
export const PDF_PROVIDERS = {
  myProvider: {
    id: 'myProvider',
    name: 'My Provider',
    requiresApiKey: true,
    features: ['text', 'images'],
  },
};
```

### 2. 实现解析器

`lib/pdf/pdf-providers.ts`:

```typescript
async function parseWithMyProvider(
  config: PDFParserConfig,
  pdfBuffer: Buffer
): Promise<ParsedPdfContent> {
  // 实现解析逻辑
  return {
    text: '...',
    images: [...],
    metadata: {
      pageCount: 0,
      parser: 'myProvider',
    },
  };
}
```

### 3. 添加到路由

```typescript
switch (config.providerId) {
  case 'unpdf':
    result = await parseWithUnpdf(pdfBuffer);
    break;
  case 'mineru':
    result = await parseWithMinerU(config, pdfBuffer);
    break;
  case 'myProvider':
    result = await parseWithMyProvider(config, pdfBuffer);
    break;
}
```

## 调试工具

访问 http://localhost:3000/debug/pdf-parser 测试解析功能：

- 切换提供商（unpdf/MinerU）
- 上传 PDF 文件
- 配置服务器地址
- 查看解析结果
- 检查图片映射

## 常见问题

### Q: MinerU 服务无法连接？

**A**: 检查：

```bash
# 服务状态
docker ps | grep mineru

# 网络连通性
curl http://localhost:8080/api/health

# 日志
docker logs mineru
```

### Q: 图片不显示？

**A**: 确保：

1. `imageMapping` 正确传递到 scene-stream API
2. 图片 ID 格式正确（img_1, img_2）
3. Base64 编码完整

### Q: 解析速度慢？

**A**: 优化：

```bash
# 增加 Docker 资源
docker run -d \
  --name mineru \
  -p 8080:8080 \
  --memory=4g \
  --cpus=2 \
  opendatalab/mineru:latest
```

### Q: unpdf vs MinerU 如何选择？

**A**: 选择建议：

| 场景               | 推荐   |
| ------------------ | ------ |
| 简单 PDF（纯文本） | unpdf  |
| 包含表格、公式     | MinerU |
| 需要保留布局       | MinerU |
| 快速测试           | unpdf  |
| 生产环境           | MinerU |
| 无法部署服务       | unpdf  |

## 性能建议

### MinerU 并发处理

```typescript
const files = [file1, file2, file3];

const results = await Promise.all(
  files.map((file) => {
    const formData = new FormData();
    formData.append('pdf', file);
    formData.append('providerId', 'mineru');
    return fetch('/api/parse-pdf', {
      method: 'POST',
      body: formData,
    }).then((r) => r.json());
  }),
);
```

### 结果缓存

```typescript
// 考虑缓存解析结果
const cacheKey = `pdf_${fileHash}`;
const cached = localStorage.getItem(cacheKey);
if (cached) {
  return JSON.parse(cached);
}
```

## 参考资源

- **MinerU GitHub**: https://github.com/opendatalab/MinerU
- **快速开始**: `/MINERU_QUICKSTART.md`
- **变更说明**: `/MINERU_LOCAL_DEPLOYMENT.md`
- **调试工具**: http://localhost:3000/debug/pdf-parser

---

**最后更新**: 2026-02-11
**模式**: 本地自托管
**状态**: 生产就绪
