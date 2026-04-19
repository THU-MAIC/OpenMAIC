## Element Type Definitions

- **text**: Text element
  - content: HTML string (supports h1, h2, p, ul, li tags)
  - defaultFontName: Font name
  - defaultColor: Text color

- **shape**: Shape element
  - viewBox: SVG viewBox
  - path: SVG path
  - fill: Fill color
  - fixedRatio: Whether to maintain aspect ratio

- **image**: Image element
  - src: Image ID (e.g., `img_1`) or actual URL
  - fixedRatio: Whether to maintain aspect ratio

- **chart**: Chart element
  - chartType: Chart type (bar, line, pie, radar, etc.)
  - data: Chart data
  - themeColors: Theme color array

- **latex**: Formula element
  - latex: LaTeX formula string
  - path: SVG path
  - color: Color
  - strokeWidth: Line width
  - viewBox: SVG viewBox
  - fixedRatio: true
  - align: Horizontal alignment ("left" | "center" | "right", default "center")

- **line**: Line element
  - start: Start coordinates [x, y]
  - end: End coordinates [x, y]
  - style: Line style
  - color: Color
  - points: Control points array
