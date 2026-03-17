declare module 'svg-arc-to-cubic-bezier' {
  interface ArcParams {
    px: number
    py: number
    cx: number
    cy: number
    rx: number
    ry: number
    xAxisRotation: number
    largeArcFlag: number
    sweepFlag: number
  }

  interface CubicBezierPoint {
    x: number
    y: number
    x1: number
    y1: number
    x2: number
    y2: number
  }

  export default function arcToBezier(params: ArcParams): CubicBezierPoint[]
}
