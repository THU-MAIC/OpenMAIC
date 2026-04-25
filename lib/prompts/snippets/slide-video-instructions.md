### VideoElement

```json
{
  "id": "video_001",
  "type": "video",
  "left": 100,
  "top": 150,
  "width": 500,
  "height": 281,
  "src": "gen_vid_1",
  "autoplay": false
}
```

**Required Fields**: `id`, `type`, `left`, `top`, `width`, `height`, `src` (generated video ID like "gen_vid_1"), `autoplay` (boolean)

**Video Sizing Rules**:

- `src` must be a generated video ID from the assigned media list (for example, "gen_vid_1")
- Default aspect ratio: 16:9 -> `height = width / 1.778`
- Typical video width: 400-600px (prominent on slide)
- Position video as a focal element, usually centered or in the main content area
- Leave space for a title and optional caption text
