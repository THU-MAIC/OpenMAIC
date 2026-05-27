### ImageElement

```json
{
  "id": "image_001",
  "type": "image",
  "left": 100,
  "top": 150,
  "width": 400,
  "height": 300,
  "src": "img_1",
  "fixedRatio": true
}
```

**Required Fields**: `id`, `type`, `left`, `top`, `width`, `height`, `src` (source image ID like "img_1"), `fixedRatio` (always true)

**Source Image Sizing Rules (keep original aspect ratio)**:

- `src` must be an image ID from the assigned media list (for example, "img_1"). Do not use URLs or invented IDs
- If no suitable source image exists, do not create image elements; use text and shapes only
- When dimensions are provided (for example, "img_1: 884x424, ratio 2.08"):
  - Choose a width based on layout needs, typically 300-500px
  - Calculate `height = width / aspect_ratio`
  - Example: ratio 2.08, width 400 -> height = 400 / 2.08 ~= 192
- When dimensions are not provided, use 4:3 default (width:height ~= 1.33)
- Ensure the image stays within canvas margins (50px from each edge)
