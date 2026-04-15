# PDF 

 PDF 。

## 

### 1. unpdf ()

- ****: ，
- ****: 、
- ****: 
- ****:  PDF 

### 2. MinerU ()

- ****: （）
- ****:
  - （ Markdown ）
  - 
  - （LaTeX）
  -  OCR 
  - （markdown, JSON, docx, html, latex）
- ****:
  -  MinerU （Docker ）
  - 
- ****: 、

## 

###  MinerU（）

```bash
# Docker （）
docker pull opendatalab/mineru:latest
docker run -d --name mineru -p 8080:8080 opendatalab/mineru:latest

# 
curl http://localhost:8080/api/health
```

### API 

####  unpdf（）

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

####  MinerU（）

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

## 

```typescript
interface ParsedPdfContent {
  text: string; // （MinerU  Markdown）
  images: string[]; // Base64 

  // （MinerU）
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

    // （MinerU）
    imageMapping?: Record<string, string>; // img_1 -> base64 URL
    pdfImages?: Array<{
      id: string; // img_1, img_2, etc.
      src: string; // base64 data URL
      pageNumber: number; // PDF 
      description?: string; // 
    }>;
  };
}
```

## 

MinerU ：

```typescript
// 1.  PDF
const parseResult = await parsePDF(
  {
    providerId: 'mineru',
    baseUrl: 'http://localhost:8080',
  },
  buffer,
);

// 2. 
const pdfText = parseResult.text; // Markdown（ img_1 ）
const pdfImages = parseResult.metadata.pdfImages; // 
const imageMapping = parseResult.metadata.imageMapping; // 

// 3. 
await generateSceneOutlinesFromRequirements(
  requirements,
  pdfText, // Markdown 
  pdfImages, // 
  aiCall,
);

// 4. （）
await buildSceneFromOutline(
  outline,
  aiCall,
  stageId,
  assignedImages, //  pdfImages 
  imageMapping, //  img_1  URL
);
```

## 

MinerU ：

1. ****: PDF → MinerU → Markdown + 
2. ****: `![alt](images/img_1.png)` → `![alt](img_1)`
3. ****:  `{ "img_1": "data:image/png;base64,..." }`
4. ****: AI  `img_1` 
5. ****: `resolveImageIds()`  URL
6. ****: 

## 

### 

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

### 

```typescript
//  API 
formData.append('providerId', 'mineru');
formData.append('baseUrl', 'http://your-server:8080');
formData.append('apiKey', 'optional');
```

## 

### 1. 

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

### 2. 

`lib/pdf/pdf-providers.ts`:

```typescript
async function parseWithMyProvider(
  config: PDFParserConfig,
  pdfBuffer: Buffer
): Promise<ParsedPdfContent> {
  // 
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

### 3. 

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

## 

 http://localhost:3000/debug/pdf-parser ：

- （unpdf/MinerU）
-  PDF 
- 
- 
- 

## 

### Q: MinerU ？

**A**: ：

```bash
# 
docker ps | grep mineru

# 
curl http://localhost:8080/api/health

# 
docker logs mineru
```

### Q: ？

**A**: ：

1. `imageMapping`  scene-stream API
2.  ID （img_1, img_2）
3. Base64 

### Q: ？

**A**: ：

```bash
#  Docker 
docker run -d \
  --name mineru \
  -p 8080:8080 \
  --memory=4g \
  --cpus=2 \
  opendatalab/mineru:latest
```

### Q: unpdf vs MinerU ？

**A**: ：

|                |    |
| ------------------ | ------ |
|  PDF（） | unpdf  |
| 、     | MinerU |
|        | MinerU |
|            | unpdf  |
|            | MinerU |
|        | unpdf  |

## 

### MinerU 

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

### 

```typescript
// 
const cacheKey = `pdf_${fileHash}`;
const cached = localStorage.getItem(cacheKey);
if (cached) {
  return JSON.parse(cached);
}
```

## 

- **MinerU GitHub**: https://github.com/opendatalab/MinerU
- ****: `/MINERU_QUICKSTART.md`
- ****: `/MINERU_LOCAL_DEPLOYMENT.md`
- ****: http://localhost:3000/debug/pdf-parser

---

****: 2026-02-11
****: 
****: 
