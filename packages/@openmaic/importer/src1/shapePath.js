/* eslint-disable max-lines */

import { RATIO_EMUs_Points } from './constants'
import { getTextByPathList } from './utils'

function shapePie(H, w, adj1, adj2, isClose) {
  const pieVal = parseInt(adj2)
  const piAngle = parseInt(adj1)
  const size = parseInt(H)
  const radius = size / 2

  let value = pieVal - piAngle
  if (value < 0) value = 360 + value
  value = Math.min(Math.max(value, 0), 360)

  const x = Math.cos((2 * Math.PI) / (360 / value))
  const y = Math.sin((2 * Math.PI) / (360 / value))

  let longArc, d
  if (isClose) {
    longArc = (value <= 180) ? 0 : 1
    d = `M${radius},${radius} L${radius},0 A${radius},${radius} 0 ${longArc},1 ${radius + y * radius},${radius - x * radius} z`
  } 
  else {
    longArc = (value <= 180) ? 0 : 1
    const radius1 = radius
    const radius2 = w / 2
    d = `M${radius1},0 A${radius2},${radius1} 0 ${longArc},1 ${radius2 + y * radius2},${radius1 - x * radius1}`
  }

  return d
}
function shapeGear(h, points) {
  const innerRadius = h
  const outerRadius = 1.5 * innerRadius
  const cx = outerRadius
  const cy = outerRadius
  const notches = points
  const radiusO = outerRadius
  const radiusI = innerRadius
  const taperO = 50
  const taperI = 35
  const pi2 = 2 * Math.PI
  const angle = pi2 / (notches * 2)
  const taperAI = angle * taperI * 0.005
  const taperAO = angle * taperO * 0.005

  let a = angle
  let toggle = false

  let d = ' M' + (cx + radiusO * Math.cos(taperAO)) + ' ' + (cy + radiusO * Math.sin(taperAO))

  for (; a <= pi2 + angle; a += angle) {
    if (toggle) {
      d += ' L' + (cx + radiusI * Math.cos(a - taperAI)) + ',' + (cy + radiusI * Math.sin(a - taperAI))
      d += ' L' + (cx + radiusO * Math.cos(a + taperAO)) + ',' + (cy + radiusO * Math.sin(a + taperAO))
    } 
    else {
      d += ' L' + (cx + radiusO * Math.cos(a - taperAO)) + ',' + (cy + radiusO * Math.sin(a - taperAO))
      d += ' L' + (cx + radiusI * Math.cos(a + taperAI)) + ',' + (cy + radiusI * Math.sin(a + taperAI))
    }
    toggle = !toggle
  }
  d += ' '
  return d
}

function shapeArc(cX, cY, rX, rY, stAng, endAng, isClose) {
  let dData = ''
  const increment = (endAng >= stAng) ? 1 : -1
  let angle = stAng

  const condition = (a) => (increment > 0 ? a <= endAng : a >= endAng)

  while (condition(angle)) {
    const radians = angle * (Math.PI / 180)
    const x = cX + Math.cos(radians) * rX
    const y = cY + Math.sin(radians) * rY
    if (angle === stAng) {
      dData = ` M${x} ${y}`
    }
    dData += ` L${x} ${y}`
    angle += increment
  }

  if (isClose) {
    dData += ' z'
  }
  return dData
}

function shapeSnipRoundRect(w, h, adj1, adj2, shapeType, adjType) {
  let adjA, adjB, adjC, adjD

  switch (adjType) {
    case 'cornr1':
      adjA = 0
      adjB = 0
      adjC = 0
      adjD = adj1
      break
    case 'cornr2':
      adjA = adj1
      adjB = adj2
      adjC = adj2
      adjD = adj1
      break
    case 'cornrAll':
      adjA = adj1
      adjB = adj1
      adjC = adj1
      adjD = adj1
      break
    case 'diag':
      adjA = adj1
      adjB = adj2
      adjC = adj1
      adjD = adj2
      break
    case 'cornrTL':
      adjA = adj1
      adjB = 0
      adjC = 0
      adjD = 0
      break
    default:
      adjA = adjB = adjC = adjD = 0
  }

  if (shapeType === 'round') {
    return `M0,${h / 2 + (1 - adjB) * (h / 2)} Q0,${h} ${adjB * (w / 2)},${h} L${w / 2 + (1 - adjC) * (w / 2)},${h} Q${w},${h} ${w},${h / 2 + (h / 2) * (1 - adjC)} L${w},${(h / 2) * adjD} Q${w},0 ${w / 2 + (w / 2) * (1 - adjD)},0 L${(w / 2) * adjA},0 Q0,0 0,${(h / 2) * (adjA)} z`
  } 
  else if (shapeType === 'snip') {
    return `M0,${adjA * (h / 2)} L0,${h / 2 + (h / 2) * (1 - adjB)} L${adjB * (w / 2)},${h} L${w / 2 + (w / 2) * (1 - adjC)},${h} L${w},${h / 2 + (h / 2) * (1 - adjC)} L${w},${adjD * (h / 2)} L${w / 2 + (w / 2) * (1 - adjD)},0 L${(w / 2) * adjA},0 z`
  }
  return ''
}

export function getShapePath(shapType, w, h, node) {
  let pathData = ''

  switch (shapType) {
    case 'rect':
    case 'actionButtonBlank':
      pathData = `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`
      break
    case 'flowChartPredefinedProcess':
      pathData = `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z M ${w * (1 / 8)} 0 L ${w * (1 / 8)} ${h} M ${w * (7 / 8)} 0 L ${w * (7 / 8)} ${h}`
      break
    case 'flowChartInternalStorage':
      pathData = `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z M ${w * (1 / 8)} 0 L ${w * (1 / 8)} ${h} M 0 ${h * (1 / 8)} L ${w} ${h * (1 / 8)}`
      break
    case 'flowChartCollate':
      pathData = `M 0,0 L ${w},0 L 0,${h} L ${w},${h} z`
      break
    case 'flowChartDocument':
      {
        const x1 = w * 10800 / 21600
        const y1 = h * 17322 / 21600
        const y2 = h * 20172 / 21600
        const y3 = h * 23922 / 21600
        pathData = `M 0,0 L ${w},0 L ${w},${y1} C ${x1},${y1} ${x1},${y3} 0,${y2} z`
      }
      break
    case 'flowChartMultidocument':
      {
        const y1 = h * 18022 / 21600
        const y2 = h * 3675 / 21600
        const y3 = h * 23542 / 21600
        const y4 = h * 1815 / 21600
        const y5 = h * 16252 / 21600
        const y6 = h * 16352 / 21600
        const y7 = h * 14392 / 21600
        const y8 = h * 20782 / 21600
        const y9 = h * 14467 / 21600
        const x1 = w * 1532 / 21600
        const x2 = w * 20000 / 21600
        const x3 = w * 9298 / 21600
        const x4 = w * 19298 / 21600
        const x5 = w * 18595 / 21600
        const x6 = w * 2972 / 21600
        const x7 = w * 20800 / 21600
        pathData = `M 0,${y2} L ${x5},${y2} L ${x5},${y1} C ${x3},${y1} ${x3},${y3} 0,${y8} z M ${x1},${y2} L ${x1},${y4} L ${x2},${y4} L ${x2},${y5} C ${x4},${y5} ${x5},${y6} ${x5},${y6} M ${x6},${y4} L ${x6},0 L ${w},0 L ${w},${y7} C ${x7},${y7} ${x2},${y9} ${x2},${y9}`
      }
      break
    case 'actionButtonBackPrevious':
      {
        const hc = w / 2,
          vc = h / 2,
          ss = Math.min(w, h)
        const dx2 = ss * 3 / 8
        const g9 = vc - dx2
        const g10 = vc + dx2
        const g11 = hc - dx2
        const g12 = hc + dx2
        pathData = `M 0,0 L ${w},0 L ${w},${h} L 0,${h} z M ${g11},${vc} L ${g12},${g9} L ${g12},${g10} z`
      }
      break
    case 'actionButtonBeginning':
      {
        const hc = w / 2,
          vc = h / 2,
          ss = Math.min(w, h)
        const dx2 = ss * 3 / 8
        const g9 = vc - dx2
        const g10 = vc + dx2
        const g11 = hc - dx2
        const g12 = hc + dx2
        const g13 = ss * 3 / 4
        const g14 = g13 / 8
        const g15 = g13 / 4
        const g16 = g11 + g14
        const g17 = g11 + g15
        pathData = `M 0,0 L ${w},0 L ${w},${h} L 0,${h} z M ${g17},${vc} L ${g12},${g9} L ${g12},${g10} z M ${g16},${g9} L ${g11},${g9} L ${g11},${g10} L ${g16},${g10} z`
      }
      break
    case 'actionButtonDocument':
      {
        const hc = w / 2,
          vc = h / 2,
          ss = Math.min(w, h)
        const dx2 = ss * 3 / 8
        const g9 = vc - dx2
        const g10 = vc + dx2
        const dx1 = ss * 9 / 32
        const g11 = hc - dx1
        const g12 = hc + dx1
        const g13 = ss * 3 / 16
        const g14 = g12 - g13
        const g15 = g9 + g13
        pathData = `M 0,0 L ${w},0 L ${w},${h} L 0,${h} z M ${g11},${g9} L ${g14},${g9} L ${g12},${g15} L ${g12},${g10} L ${g11},${g10} z M ${g14},${g9} L ${g14},${g15} L ${g12},${g15} z`
      }
      break
    case 'actionButtonEnd':
      {
        const hc = w / 2,
          vc = h / 2,
          ss = Math.min(w, h)
        const dx2 = ss * 3 / 8
        const g9 = vc - dx2
        const g10 = vc + dx2
        const g11 = hc - dx2
        const g12 = hc + dx2
        const g13 = ss * 3 / 4
        const g14 = g13 * 3 / 4
        const g15 = g13 * 7 / 8
        const g16 = g11 + g14
        const g17 = g11 + g15
        pathData = `M 0,${h} L ${w},${h} L ${w},0 L 0,0 z M ${g17},${g9} L ${g12},${g9} L ${g12},${g10} L ${g17},${g10} z M ${g16},${vc} L ${g11},${g9} L ${g11},${g10} z`
      }
      break
    case 'actionButtonForwardNext':
      {
        const hc = w / 2,
          vc = h / 2,
          ss = Math.min(w, h)
        const dx2 = ss * 3 / 8
        const g9 = vc - dx2
        const g10 = vc + dx2
        const g11 = hc - dx2
        const g12 = hc + dx2
        pathData = `M 0,${h} L ${w},${h} L ${w},0 L 0,0 z M ${g12},${vc} L ${g11},${g9} L ${g11},${g10} z`
      }
      break
    case 'actionButtonHelp':
      {
        const hc = w / 2,
          vc = h / 2,
          ss = Math.min(w, h)
        const dx2 = ss * 3 / 8
        const g9 = vc - dx2
        const g11 = hc - dx2
        const g13 = ss * 3 / 4
        const g14 = g13 / 7
        const g15 = g13 * 3 / 14
        const g16 = g13 * 2 / 7
        const g19 = g13 * 3 / 7
        const g20 = g13 * 4 / 7
        const g21 = g13 * 17 / 28
        const g23 = g13 * 21 / 28
        const g24 = g13 * 11 / 14
        const g27 = g9 + g16
        const g29 = g9 + g21
        const g30 = g9 + g23
        const g31 = g9 + g24
        const g33 = g11 + g15
        const g36 = g11 + g19
        const g37 = g11 + g20
        const g41 = g13 / 14
        const g42 = g13 * 3 / 28
        const cX1 = g33 + g16
        const cX2 = g36 + g14
        const cY3 = g31 + g42
        const cX4 = (g37 + g36 + g16) / 2
        pathData = `M 0,0 L ${w},0 L ${w},${h} L 0,${h} z M ${g33},${g27} ${shapeArc(cX1, g27, g16, g16, 180, 360, false).replace('M', 'L')} ${shapeArc(cX4, g27, g14, g15, 0, 90, false).replace('M', 'L')} ${shapeArc(cX4, g29, g41, g42, 270, 180, false).replace('M', 'L')} L ${g37},${g30} L ${g36},${g30} L ${g36},${g29} ${shapeArc(cX2, g29, g14, g15, 180, 270, false).replace('M', 'L')} ${shapeArc(g37, g27, g41, g42, 90, 0, false).replace('M', 'L')} ${shapeArc(cX1, g27, g14, g14, 0, -180, false).replace('M', 'L')} z M ${hc},${g31} ${shapeArc(hc, cY3, g42, g42, 270, 630, false).replace('M', 'L')} z`
      }
      break
    case 'actionButtonHome':
      {
        const hc = w / 2,
          vc = h / 2,
          ss = Math.min(w, h)
        const dx2 = ss * 3 / 8
        const g9 = vc - dx2
        const g10 = vc + dx2
        const g11 = hc - dx2
        const g12 = hc + dx2
        const g13 = ss * 3 / 4
        const g14 = g13 / 16
        const g15 = g13 / 8
        const g16 = g13 * 3 / 16
        const g17 = g13 * 5 / 16
        const g18 = g13 * 7 / 16
        const g19 = g13 * 9 / 16
        const g20 = g13 * 11 / 16
        const g21 = g13 * 3 / 4
        const g22 = g13 * 13 / 16
        const g23 = g13 * 7 / 8
        const g24 = g9 + g14
        const g25 = g9 + g16
        const g26 = g9 + g17
        const g27 = g9 + g21
        const g28 = g11 + g15
        const g29 = g11 + g18
        const g30 = g11 + g19
        const g31 = g11 + g20
        const g32 = g11 + g22
        const g33 = g11 + g23
        pathData = `M 0,0 L ${w},0 L ${w},${h} L 0,${h} z M ${hc},${g9} L ${g11},${vc} L ${g28},${vc} L ${g28},${g10} L ${g33},${g10} L ${g33},${vc} L ${g12},${vc} L ${g32},${g26} L ${g32},${g24} L ${g31},${g24} L ${g31},${g25} z M ${g29},${g27} L ${g30},${g27} L ${g30},${g10} L ${g29},${g10} z`
      }
      break
    case 'actionButtonInformation':
      {
        const hc = w / 2,
          vc = h / 2,
          ss = Math.min(w, h)
        const dx2 = ss * 3 / 8
        const g9 = vc - dx2
        const g11 = hc - dx2
        const g13 = ss * 3 / 4
        const g14 = g13 / 32
        const g17 = g13 * 5 / 16
        const g18 = g13 * 3 / 8
        const g19 = g13 * 13 / 32
        const g20 = g13 * 19 / 32
        const g22 = g13 * 11 / 16
        const g23 = g13 * 13 / 16
        const g24 = g13 * 7 / 8
        const g25 = g9 + g14
        const g28 = g9 + g17
        const g29 = g9 + g18
        const g30 = g9 + g23
        const g31 = g9 + g24
        const g32 = g11 + g17
        const g34 = g11 + g19
        const g35 = g11 + g20
        const g37 = g11 + g22
        const g38 = g13 * 3 / 32
        const cY1 = g9 + dx2
        const cY2 = g25 + g38
        pathData = `M 0,0 L ${w},0 L ${w},${h} L 0,${h} z M ${hc},${g9} ${shapeArc(hc, cY1, dx2, dx2, 270, 630, false).replace('M', 'L')} z M ${hc},${g25} ${shapeArc(hc, cY2, g38, g38, 270, 630, false).replace('M', 'L')} M ${g32},${g28} L ${g35},${g28} L ${g35},${g30} L ${g37},${g30} L ${g37},${g31} L ${g32},${g31} L ${g32},${g30} L ${g34},${g30} L ${g34},${g29} L ${g32},${g29} z`
      }
      break
    case 'actionButtonMovie':
      {
        const hc = w / 2,
          vc = h / 2,
          ss = Math.min(w, h)
        const g11 = hc - (ss * 3 / 8)
        const g9 = vc - (ss * 3 / 8)
        const g12 = hc + (ss * 3 / 8)
        const g13 = ss * 3 / 4
        const g14 = g13 * 1455 / 21600
        const g15 = g13 * 1905 / 21600
        const g16 = g13 * 2325 / 21600
        const g17 = g13 * 16155 / 21600
        const g18 = g13 * 17010 / 21600
        const g19 = g13 * 19335 / 21600
        const g20 = g13 * 19725 / 21600
        const g21 = g13 * 20595 / 21600
        const g22 = g13 * 5280 / 21600
        const g23 = g13 * 5730 / 21600
        const g24 = g13 * 6630 / 21600
        const g25 = g13 * 7492 / 21600
        const g26 = g13 * 9067 / 21600
        const g27 = g13 * 9555 / 21600
        const g28 = g13 * 13342 / 21600
        const g29 = g13 * 14580 / 21600
        const g30 = g13 * 15592 / 21600
        const g31 = g11 + g14
        const g32 = g11 + g15
        const g33 = g11 + g16
        const g34 = g11 + g17
        const g35 = g11 + g18
        const g36 = g11 + g19
        const g37 = g11 + g20
        const g38 = g11 + g21
        const g39 = g9 + g22
        const g40 = g9 + g23
        const g41 = g9 + g24
        const g42 = g9 + g25
        const g43 = g9 + g26
        const g44 = g9 + g27
        const g45 = g9 + g28
        const g46 = g9 + g29
        const g47 = g9 + g30
        pathData = `M 0,${h} L ${w},${h} L ${w},0 L 0,0 z M ${g11},${g39} L ${g11},${g44} L ${g31},${g44} L ${g32},${g43} L ${g33},${g43} L ${g33},${g47} L ${g35},${g47} L ${g35},${g45} L ${g36},${g45} L ${g38},${g46} L ${g12},${g46} L ${g12},${g41} L ${g38},${g41} L ${g37},${g42} L ${g35},${g42} L ${g35},${g41} L ${g34},${g40} L ${g32},${g40} L ${g31},${g39} z`
      }
      break
    case 'actionButtonReturn':
      {
        const hc = w / 2,
          vc = h / 2,
          ss = Math.min(w, h)
        const dx2 = ss * 3 / 8
        const g9 = vc - dx2
        const g10 = vc + dx2
        const g11 = hc - dx2
        const g12 = hc + dx2
        const g13 = ss * 3 / 4
        const g14 = g13 * 7 / 8
        const g15 = g13 * 3 / 4
        const g16 = g13 * 5 / 8
        const g17 = g13 * 3 / 8
        const g18 = g13 / 4
        const g19 = g9 + g15
        const g20 = g9 + g16
        const g21 = g9 + g18
        const g22 = g11 + g14
        const g23 = g11 + g15
        const g24 = g11 + g16
        const g25 = g11 + g17
        const g26 = g11 + g18
        const g27 = g13 / 8
        const cX1 = g24 - g27
        const cY2 = g19 - g27
        const cX3 = g11 + g17
        const cY4 = g10 - g17
        pathData = `M 0,${h} L ${w},${h} L ${w},0 L 0,0 z M ${g12},${g21} L ${g23},${g9} L ${hc},${g21} L ${g24},${g21} L ${g24},${g20} ${shapeArc(cX1, g20, g27, g27, 0, 90, false).replace('M', 'L')} L ${g25},${g19} ${shapeArc(g25, cY2, g27, g27, 90, 180, false).replace('M', 'L')} L ${g26},${g21} L ${g11},${g21} L ${g11},${g20} ${shapeArc(cX3, g20, g17, g17, 180, 90, false).replace('M', 'L')} L ${hc},${g10} ${shapeArc(hc, cY4, g17, g17, 90, 0, false).replace('M', 'L')} L ${g22},${g21} z`
      }
      break
    case 'actionButtonSound':
      {
        const hc = w / 2,
          vc = h / 2,
          ss = Math.min(w, h)
        const dx2 = ss * 3 / 8
        const g9 = vc - dx2
        const g10 = vc + dx2
        const g11 = hc - dx2
        const g12 = hc + dx2
        const g13 = ss * 3 / 4
        const g14 = g13 / 8
        const g15 = g13 * 5 / 16
        const g16 = g13 * 5 / 8
        const g17 = g13 * 11 / 16
        const g18 = g13 * 3 / 4
        const g19 = g13 * 7 / 8
        const g20 = g9 + g14
        const g21 = g9 + g15
        const g22 = g9 + g17
        const g23 = g9 + g19
        const g24 = g11 + g15
        const g25 = g11 + g16
        const g26 = g11 + g18
        pathData = `M 0,0 L ${w},0 L ${w},${h} L 0,${h} z M ${g11},${g21} L ${g24},${g21} L ${g25},${g9} L ${g25},${g10} L ${g24},${g22} L ${g11},${g22} z M ${g26},${g21} L ${g12},${g20} M ${g26},${vc} L ${g12},${vc} M ${g26},${g22} L ${g12},${g23}`
      }
      break
    case 'irregularSeal1':
      pathData = `M ${w * 10800 / 21600},${h * 5800 / 21600} L ${w * 14522 / 21600},0 L ${w * 14155 / 21600},${h * 5325 / 21600} L ${w * 18380 / 21600},${h * 4457 / 21600} L ${w * 16702 / 21600},${h * 7315 / 21600} L ${w * 21097 / 21600},${h * 8137 / 21600} L ${w * 17607 / 21600},${h * 10475 / 21600} L ${w},${h * 13290 / 21600} L ${w * 16837 / 21600},${h * 12942 / 21600} L ${w * 18145 / 21600},${h * 18095 / 21600} L ${w * 14020 / 21600},${h * 14457 / 21600} L ${w * 13247 / 21600},${h * 19737 / 21600} L ${w * 10532 / 21600},${h * 14935 / 21600} L ${w * 8485 / 21600},${h} L ${w * 7715 / 21600},${h * 15627 / 21600} L ${w * 4762 / 21600},${h * 17617 / 21600} L ${w * 5667 / 21600},${h * 13937 / 21600} L ${w * 135 / 21600},${h * 14587 / 21600} L ${w * 3722 / 21600},${h * 11775 / 21600} L 0,${h * 8615 / 21600} L ${w * 4627 / 21600},${h * 7617 / 21600} L ${w * 370 / 21600},${h * 2295 / 21600} L ${w * 7312 / 21600},${h * 6320 / 21600} L ${w * 8352 / 21600},${h * 2295 / 21600} z`
      break
    case 'irregularSeal2':
      pathData = `M ${w * 11462 / 21600},${h * 4342 / 21600} L ${w * 14790 / 21600},0 L ${w * 14525 / 21600},${h * 5777 / 21600} L ${w * 18007 / 21600},${h * 3172 / 21600} L ${w * 16380 / 21600},${h * 6532 / 21600} L ${w},${h * 6645 / 21600} L ${w * 16985 / 21600},${h * 9402 / 21600} L ${w * 18270 / 21600},${h * 11290 / 21600} L ${w * 16380 / 21600},${h * 12310 / 21600} L ${w * 18877 / 21600},${h * 15632 / 21600} L ${w * 14640 / 21600},${h * 14350 / 21600} L ${w * 14942 / 21600},${h * 17370 / 21600} L ${w * 12180 / 21600},${h * 15935 / 21600} L ${w * 11612 / 21600},${h * 18842 / 21600} L ${w * 9872 / 21600},${h * 17370 / 21600} L ${w * 8700 / 21600},${h * 19712 / 21600} L ${w * 7527 / 21600},${h * 18125 / 21600} L ${w * 4917 / 21600},${h} L ${w * 4805 / 21600},${h * 18240 / 21600} L ${w * 1285 / 21600},${h * 17825 / 21600} L ${w * 3330 / 21600},${h * 15370 / 21600} L 0,${h * 12877 / 21600} L ${w * 3935 / 21600},${h * 11592 / 21600} L ${w * 1172 / 21600},${h * 8270 / 21600} L ${w * 5372 / 21600},${h * 7817 / 21600} L ${w * 4502 / 21600},${h * 3625 / 21600} L ${w * 8550 / 21600},${h * 6382 / 21600} L ${w * 9722 / 21600},${h * 1887 / 21600} z`
      break
    case 'flowChartTerminator':
      {
        const cd2 = 180,
          cd4 = 90,
          c3d4 = 270
        const x1 = w * 3475 / 21600
        const x2 = w * 18125 / 21600
        const y1 = h * 10800 / 21600
        pathData = `M ${x1},0 L ${x2},0 ${shapeArc(x2, h / 2, x1, y1, c3d4, c3d4 + cd2, false).replace('M', 'L')} L ${x1},${h} ${shapeArc(x1, h / 2, x1, y1, cd4, cd4 + cd2, false).replace('M', 'L')} z`
      }
      break
    case 'flowChartPunchedTape':
      {
        const cd2 = 180
        const x1 = w * 5 / 20
        const y1 = h * 2 / 20
        const y2 = h * 18 / 20
        pathData = `M 0,${y1} ${shapeArc(x1, y1, x1, y1, cd2, 0, false).replace('M', 'L')} ${shapeArc(w * (3 / 4), y1, x1, y1, cd2, 360, false).replace('M', 'L')} L ${w},${y2} ${shapeArc(w * (3 / 4), y2, x1, y1, 0, -cd2, false).replace('M', 'L')} ${shapeArc(x1, y2, x1, y1, 0, cd2, false).replace('M', 'L')} z`
      }
      break
    case 'flowChartOnlineStorage':
      {
        const c3d4 = 270,
          cd4 = 90
        const x1 = w * 1 / 6
        const y1 = h * 3 / 6
        pathData = `M ${x1},0 L ${w},0 ${shapeArc(w, h / 2, x1, y1, c3d4, 90, false).replace('M', 'L')} L ${x1},${h} ${shapeArc(x1, h / 2, x1, y1, cd4, 270, false).replace('M', 'L')} z`
      }
      break
    case 'flowChartDisplay':
      {
        const c3d4 = 270,
          cd2 = 180
        const x1 = w * 1 / 6
        const x2 = w * 5 / 6
        const y1 = h * 3 / 6
        pathData = `M 0,${y1} L ${x1},0 L ${x2},0 ${shapeArc(w, h / 2, x1, y1, c3d4, c3d4 + cd2, false).replace('M', 'L')} L ${x1},${h} z`
      }
      break
    case 'flowChartDelay':
      {
        const wd2 = w / 2,
          hd2 = h / 2,
          cd2 = 180,
          c3d4 = 270
        pathData = `M 0,0 L ${wd2},0 ${shapeArc(wd2, hd2, wd2, hd2, c3d4, c3d4 + cd2, false).replace('M', 'L')} L 0,${h} z`
      }
      break
    case 'flowChartMagneticTape':
      {
        const wd2 = w / 2,
          hd2 = h / 2,
          cd2 = 180,
          c3d4 = 270,
          cd4 = 90
        const idy = hd2 * Math.sin(Math.PI / 4)
        const ib = hd2 + idy
        const ang1 = Math.atan(h / w)
        const ang1Dg = ang1 * 180 / Math.PI
        pathData = `M ${wd2},${h} ${shapeArc(wd2, hd2, wd2, hd2, cd4, cd2, false).replace('M', 'L')} ${shapeArc(wd2, hd2, wd2, hd2, cd2, c3d4, false).replace('M', 'L')} ${shapeArc(wd2, hd2, wd2, hd2, c3d4, 360, false).replace('M', 'L')} ${shapeArc(wd2, hd2, wd2, hd2, 0, ang1Dg, false).replace('M', 'L')} L ${w},${ib} L ${w},${h} z`
      }
      break
    case 'ellipse':
    case 'flowChartConnector':
    case 'flowChartSummingJunction':
    case 'flowChartOr':
      {
        const cx = w / 2
        const cy = h / 2
        const rx = w / 2
        const ry = h / 2

        pathData = `M ${cx - rx},${cy} A ${rx},${ry} 0 1,0 ${cx + rx},${cy} A ${rx},${ry} 0 1,0 ${cx - rx},${cy} Z`

        if (shapType === 'flowChartOr') {
          pathData += ` M ${w / 2} 0 L ${w / 2} ${h} M 0 ${h / 2} L ${w} ${h / 2}`
        } 
        else if (shapType === 'flowChartSummingJunction') {
          const angVal = Math.PI / 4
          const iDx = (w / 2) * Math.cos(angVal)
          const idy = (h / 2) * Math.sin(angVal)
          const il = cx - iDx
          const ir = cx + iDx
          const it = cy - idy
          const ib = cy + idy
          pathData += ` M ${il} ${it} L ${ir} ${ib} M ${ir} ${it} L ${il} ${ib}`
        }
      }
      break
    case 'roundRect':
    case 'round1Rect':
    case 'round2DiagRect':
    case 'round2SameRect':
    case 'snip1Rect':
    case 'snip2DiagRect':
    case 'snip2SameRect':
    case 'flowChartAlternateProcess':
    case 'flowChartPunchedCard':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let sAdj1_val, sAdj2_val
        let shpTyp, adjTyp

        if (shapAdjst_ary && Array.isArray(shapAdjst_ary)) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              const sAdj1 = getTextByPathList(adj, ['attrs', 'fmla'])
              sAdj1_val = parseInt(sAdj1.substring(4)) / 50000
            } 
            else if (sAdj_name === 'adj2') {
              const sAdj2 = getTextByPathList(adj, ['attrs', 'fmla'])
              sAdj2_val = parseInt(sAdj2.substring(4)) / 50000
            }
          }
        } 
        else if (shapAdjst_ary) {
          const sAdj = getTextByPathList(shapAdjst_ary, ['attrs', 'fmla'])
          sAdj1_val = parseInt(sAdj.substring(4)) / 50000
          sAdj2_val = 0
        }

        switch (shapType) {
          case 'roundRect':
          case 'flowChartAlternateProcess':
            shpTyp = 'round'
            adjTyp = 'cornrAll'
            if (sAdj1_val === undefined) sAdj1_val = 0.33334
            sAdj2_val = 0
            break
          case 'round1Rect':
            shpTyp = 'round'
            adjTyp = 'cornr1'
            if (sAdj1_val === undefined) sAdj1_val = 0.33334
            sAdj2_val = 0
            break
          case 'round2DiagRect':
            shpTyp = 'round'
            adjTyp = 'diag'
            if (sAdj1_val === undefined) sAdj1_val = 0.33334
            if (sAdj2_val === undefined) sAdj2_val = 0
            break
          case 'round2SameRect':
            shpTyp = 'round'
            adjTyp = 'cornr2'
            if (sAdj1_val === undefined) sAdj1_val = 0.33334
            if (sAdj2_val === undefined) sAdj2_val = 0
            break
          case 'snip1Rect':
            shpTyp = 'snip'
            adjTyp = 'cornr1'
            if (sAdj1_val === undefined) sAdj1_val = 0.33334
            sAdj2_val = 0
            break
          case 'flowChartPunchedCard':
            shpTyp = 'snip'
            adjTyp = 'cornrTL'
            if (sAdj1_val === undefined) sAdj1_val = 0.33334
            sAdj2_val = 0
            break
          case 'snip2DiagRect':
            shpTyp = 'snip'
            adjTyp = 'diag'
            if (sAdj1_val === undefined) sAdj1_val = 0
            if (sAdj2_val === undefined) sAdj2_val = 0.33334
            break
          case 'snip2SameRect':
            shpTyp = 'snip'
            adjTyp = 'cornr2'
            if (sAdj1_val === undefined) sAdj1_val = 0.33334
            if (sAdj2_val === undefined) sAdj2_val = 0
            break
          default:
        }
        pathData = shapeSnipRoundRect(w, h, sAdj1_val, sAdj2_val, shpTyp, adjTyp)
      }
      break
    case 'snipRoundRect':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let sAdj1_val = 0.33334
        let sAdj2_val = 0.33334
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              const sAdj1 = getTextByPathList(adj, ['attrs', 'fmla'])
              sAdj1_val = parseInt(sAdj1.substring(4)) / 50000
            } 
            else if (sAdj_name === 'adj2') {
              const sAdj2 = getTextByPathList(adj, ['attrs', 'fmla'])
              sAdj2_val = parseInt(sAdj2.substring(4)) / 50000
            }
          }
        }
        pathData = `M0,${h} L${w},${h} L${w},${(h / 2) * sAdj2_val} L${w / 2 + (w / 2) * (1 - sAdj2_val)},0 L${(w / 2) * sAdj1_val},0 Q0,0 0,${(h / 2) * sAdj1_val} z`
      }
      break
    case 'bentConnector2':
      pathData = `M ${w} 0 L ${w} ${h} L 0 ${h}`
      break
    case 'rtTriangle':
      pathData = `M 0 0 L 0 ${h} L ${w} ${h} Z`
      break
    case 'triangle':
    case 'flowChartExtract':
    case 'flowChartMerge':
      {
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd', 'attrs', 'fmla'])
        let shapAdjst_val = 0.5
        if (shapAdjst) {
          shapAdjst_val = parseInt(shapAdjst.substring(4)) * RATIO_EMUs_Points
        }

        let p1x = w * shapAdjst_val
        let p1y = 0
        let p2x = 0
        let p2y = h
        let p3x = w
        let p3y = h

        if (shapType === 'flowChartMerge') {
          [p1x, p1y] = [w - p1x, h - p1y]
          ;[p2x, p2y] = [w - p2x, h - p2y]
          ;[p3x, p3y] = [w - p3x, h - p3y]
        }

        pathData = `M ${p1x} ${p1y} L ${p2x} ${p2y} L ${p3x} ${p3y} Z`
      }
      break
    case 'diamond':
    case 'flowChartDecision':
    case 'flowChartSort':
      pathData = `M ${w / 2} 0 L 0 ${h / 2} L ${w / 2} ${h} L ${w} ${h / 2} Z`
      if (shapType === 'flowChartSort') {
        pathData += ` M 0 ${h / 2} L ${w} ${h / 2}`
      }
      break
    case 'trapezoid':
    case 'flowChartManualOperation':
    case 'flowChartManualInput':
      {
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd', 'attrs', 'fmla'])
        let adjst_val = 0.2
        const max_adj_const = 0.7407
        if (shapAdjst) {
          const adjst = parseInt(shapAdjst.substring(4)) * RATIO_EMUs_Points
          adjst_val = (adjst * 0.5) / max_adj_const
        }

        let p1x = w * adjst_val,
          p1y = 0
        let p2x = 0,
          p2y = h
        let p3x = w,
          p3y = h
        let p4x = (1 - adjst_val) * w,
          p4y = 0

        if (shapType === 'flowChartManualInput') {
          adjst_val = 0
          p1y = h / 5
          p1x = w * adjst_val
          p4x = (1 - adjst_val) * w
        }

        if (shapType === 'flowChartManualOperation') {
          [p1x, p1y] = [w - p1x, h - p1y]
          ;[p2x, p2y] = [w - p2x, h - p2y]
          ;[p3x, p3y] = [w - p3x, h - p3y]
          ;[p4x, p4y] = [w - p4x, h - p4y]
        }

        pathData = `M ${p1x} ${p1y} L ${p2x} ${p2y} L ${p3x} ${p3y} L ${p4x} ${p4y} Z`
      }
      break
    case 'parallelogram':
    case 'flowChartInputOutput':
      {
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd', 'attrs', 'fmla'])
        let adjst_val = 0.25
        if (shapAdjst) {
          const max_adj_const = w > h ? w / h : h / w
          const adjst = parseInt(shapAdjst.substring(4)) / 100000
          adjst_val = adjst / max_adj_const
        }
        pathData = `M ${adjst_val * w} 0 L 0 ${h} L ${(1 - adjst_val) * w} ${h} L ${w} 0 Z`
      }
      break
    case 'pentagon':
      pathData = `M ${0.5 * w} 0 L 0 ${0.375 * h} L ${0.15 * w} ${h} L ${0.85 * w} ${h} L ${w} ${0.375 * h} Z`
      break
    case 'hexagon':
    case 'flowChartPreparation':
      {
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd', 'attrs', 'fmla'])
        let adj = 25000 * RATIO_EMUs_Points
        if (shapAdjst) {
          adj = parseInt(shapAdjst.substring(4)) * RATIO_EMUs_Points
        }
        const vf = 115470 * RATIO_EMUs_Points
        const cnstVal1 = 50000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        const angVal1 = 60 * Math.PI / 180
        const ss = Math.min(w, h)
        const maxAdj = cnstVal1 * w / ss
        const a = (adj < 0) ? 0 : (adj > maxAdj) ? maxAdj : adj
        const hd2 = h / 2
        const shd2 = hd2 * vf / cnstVal2
        const x1 = ss * a / cnstVal2
        const x2 = w - x1
        const dy1 = shd2 * Math.sin(angVal1)
        const vc = h / 2
        const y1 = vc - dy1
        const y2 = vc + dy1
        pathData = `M 0,${vc} L ${x1},${y1} L ${x2},${y1} L ${w},${vc} L ${x2},${y2} L ${x1},${y2} z`
      }
      break
    case 'heptagon':
      pathData = `M ${0.5 * w} 0 L ${w / 8} ${h / 4} L 0 ${5 / 8 * h} L ${w / 4} ${h} L ${3 / 4 * w} ${h} L ${w} ${5 / 8 * h} L ${7 / 8 * w} ${h / 4} Z`
      break
    case 'octagon':
      {
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd', 'attrs', 'fmla'])
        let adj1 = 0.25
        if (shapAdjst) {
          adj1 = parseInt(shapAdjst.substring(4)) / 100000
        }
        const adj2 = (1 - adj1)
        pathData = `M ${adj1 * w} 0 L 0 ${adj1 * h} L 0 ${adj2 * h} L ${adj1 * w} ${h} L ${adj2 * w} ${h} L ${w} ${adj2 * h} L ${w} ${adj1 * h} L ${adj2 * w} 0 Z`
      }
      break
    case 'decagon':
      pathData = `M ${3 / 8 * w} 0 L ${w / 8} ${h / 8} L 0 ${h / 2} L ${w / 8} ${7 / 8 * h} L ${3 / 8 * w} ${h} L ${5 / 8 * w} ${h} L ${7 / 8 * w} ${7 / 8 * h} L ${w} ${h / 2} L ${7 / 8 * w} ${h / 8} L ${5 / 8 * w} 0 Z`
      break
    case 'dodecagon':
      pathData = `M ${3 / 8 * w} 0 L ${w / 8} ${h / 8} L 0 ${3 / 8 * h} L 0 ${5 / 8 * h} L ${w / 8} ${7 / 8 * h} L ${3 / 8 * w} ${h} L ${5 / 8 * w} ${h} L ${7 / 8 * w} ${7 / 8 * h} L ${w} ${5 / 8 * h} L ${w} ${3 / 8 * h} L ${7 / 8 * w} ${h / 8} L ${5 / 8 * w} 0 Z`
      break
    case 'star4':
      {
        const hc = w / 2,
          vc = h / 2,
          wd2 = w / 2,
          hd2 = h / 2
        let adj = 19098 * RATIO_EMUs_Points
        const cnstVal1 = 50000 * RATIO_EMUs_Points
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        if (shapAdjst) {
          const name = shapAdjst['attrs']['name']
          if (name === 'adj') {
            adj = parseInt(shapAdjst['attrs']['fmla'].substring(4)) * RATIO_EMUs_Points
          }
        }
        const a = (adj < 0) ? 0 : (adj > cnstVal1) ? cnstVal1 : adj
        const iwd2 = wd2 * a / cnstVal1
        const ihd2 = hd2 * a / cnstVal1
        const sdx = iwd2 * Math.cos(0.7853981634)
        const sdy = ihd2 * Math.sin(0.7853981634)
        const sx1 = hc - sdx
        const sx2 = hc + sdx
        const sy1 = vc - sdy
        const sy2 = vc + sdy
        pathData = `M 0,${vc} L ${sx1},${sy1} L ${hc},0 L ${sx2},${sy1} L ${w},${vc} L ${sx2},${sy2} L ${hc},${h} L ${sx1},${sy2} z`
      }
      break
    case 'star5':
      {
        const hc = w / 2,
          vc = h / 2,
          wd2 = w / 2,
          hd2 = h / 2
        let adj = 19098 * RATIO_EMUs_Points
        let hf = 105146 * RATIO_EMUs_Points
        let vf = 110557 * RATIO_EMUs_Points
        const maxAdj = 50000 * RATIO_EMUs_Points
        const cnstVal1 = 100000 * RATIO_EMUs_Points
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        if (shapAdjst) {
          Object.keys(shapAdjst).forEach(key => {
            const name = shapAdjst[key]['attrs']['name']
            if (name === 'adj') {
              adj = parseInt(shapAdjst[key]['attrs']['fmla'].substring(4)) * RATIO_EMUs_Points
            } 
            else if (name === 'hf') {
              hf = parseInt(shapAdjst[key]['attrs']['fmla'].substring(4)) * RATIO_EMUs_Points
            } 
            else if (name === 'vf') {
              vf = parseInt(shapAdjst[key]['attrs']['fmla'].substring(4)) * RATIO_EMUs_Points
            }
          })
        }
        const a = (adj < 0) ? 0 : (adj > maxAdj) ? maxAdj : adj
        const swd2 = wd2 * hf / cnstVal1
        const shd2 = hd2 * vf / cnstVal1
        const svc = vc * vf / cnstVal1
        const dx1 = swd2 * Math.cos(0.31415926536)
        const dx2 = swd2 * Math.cos(5.3407075111)
        const dy1 = shd2 * Math.sin(0.31415926536)
        const dy2 = shd2 * Math.sin(5.3407075111)
        const x1 = hc - dx1
        const x2 = hc - dx2
        const x3 = hc + dx2
        const x4 = hc + dx1
        const y1 = svc - dy1
        const y2 = svc - dy2
        const iwd2 = swd2 * a / maxAdj
        const ihd2 = shd2 * a / maxAdj
        const sdx1 = iwd2 * Math.cos(5.9690260418)
        const sdx2 = iwd2 * Math.cos(0.94247779608)
        const sdy1 = ihd2 * Math.sin(0.94247779608)
        const sdy2 = ihd2 * Math.sin(5.9690260418)
        const sx1 = hc - sdx1
        const sx2 = hc - sdx2
        const sx3 = hc + sdx2
        const sx4 = hc + sdx1
        const sy1 = svc - sdy1
        const sy2 = svc - sdy2
        const sy3 = svc + ihd2
        pathData = `M ${x1},${y1} L ${sx2},${sy1} L ${hc},0 L ${sx3},${sy1} L ${x4},${y1} L ${sx4},${sy2} L ${x3},${y2} L ${hc},${sy3} L ${x2},${y2} L ${sx1},${sy2} z`
      }
      break
    case 'star6':
      {
        const hc = w / 2,
          vc = h / 2,
          wd2 = w / 2,
          hd2 = h / 2,
          hd4 = h / 4
        let adj = 28868 * RATIO_EMUs_Points
        let hf = 115470 * RATIO_EMUs_Points
        const maxAdj = 50000 * RATIO_EMUs_Points
        const cnstVal1 = 100000 * RATIO_EMUs_Points
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        if (shapAdjst) {
          Object.keys(shapAdjst).forEach(key => {
            const name = shapAdjst[key]['attrs']['name']
            if (name === 'adj') {
              adj = parseInt(shapAdjst[key]['attrs']['fmla'].substring(4)) * RATIO_EMUs_Points
            } 
            else if (name === 'hf') {
              hf = parseInt(shapAdjst[key]['attrs']['fmla'].substring(4)) * RATIO_EMUs_Points
            }
          })
        }
        const a = (adj < 0) ? 0 : (adj > maxAdj) ? maxAdj : adj
        const swd2 = wd2 * hf / cnstVal1
        const dx1 = swd2 * Math.cos(0.5235987756)
        const x1 = hc - dx1
        const x2 = hc + dx1
        const y2 = vc + hd4
        const iwd2 = swd2 * a / maxAdj
        const ihd2 = hd2 * a / maxAdj
        const sdx2 = iwd2 / 2
        const sx1 = hc - iwd2
        const sx2 = hc - sdx2
        const sx3 = hc + sdx2
        const sx4 = hc + iwd2
        const sdy1 = ihd2 * Math.sin(1.0471975512)
        const sy1 = vc - sdy1
        const sy2 = vc + sdy1
        pathData = `M ${x1},${hd4} L ${sx2},${sy1} L ${hc},0 L ${sx3},${sy1} L ${x2},${hd4} L ${sx4},${vc} L ${x2},${y2} L ${sx3},${sy2} L ${hc},${h} L ${sx2},${sy2} L ${x1},${y2} L ${sx1},${vc} z`
      }
      break
    case 'star7':
      {
        const hc = w / 2,
          vc = h / 2,
          wd2 = w / 2,
          hd2 = h / 2
        let adj = 34601 * RATIO_EMUs_Points
        let hf = 102572 * RATIO_EMUs_Points
        let vf = 105210 * RATIO_EMUs_Points
        const maxAdj = 50000 * RATIO_EMUs_Points
        const cnstVal1 = 100000 * RATIO_EMUs_Points
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        if (shapAdjst) {
          Object.keys(shapAdjst).forEach(key => {
            const name = shapAdjst[key]['attrs']['name']
            if (name === 'adj') {
              adj = parseInt(shapAdjst[key]['attrs']['fmla'].substring(4)) * RATIO_EMUs_Points
            } 
            else if (name === 'hf') {
              hf = parseInt(shapAdjst[key]['attrs']['fmla'].substring(4)) * RATIO_EMUs_Points
            } 
            else if (name === 'vf') {
              vf = parseInt(shapAdjst[key]['attrs']['fmla'].substring(4)) * RATIO_EMUs_Points
            }
          })
        }
        const a = (adj < 0) ? 0 : (adj > maxAdj) ? maxAdj : adj
        const swd2 = wd2 * hf / cnstVal1
        const shd2 = hd2 * vf / cnstVal1
        const svc = vc * vf / cnstVal1
        const dx1 = swd2 * 97493 / 100000
        const dx2 = swd2 * 78183 / 100000
        const dx3 = swd2 * 43388 / 100000
        const dy1 = shd2 * 62349 / 100000
        const dy2 = shd2 * 22252 / 100000
        const dy3 = shd2 * 90097 / 100000
        const x1 = hc - dx1
        const x2 = hc - dx2
        const x3 = hc - dx3
        const x4 = hc + dx3
        const x5 = hc + dx2
        const x6 = hc + dx1
        const y1 = svc - dy1
        const y2 = svc + dy2
        const y3 = svc + dy3
        const iwd2 = swd2 * a / maxAdj
        const ihd2 = shd2 * a / maxAdj
        const sdx1 = iwd2 * 97493 / 100000
        const sdx2 = iwd2 * 78183 / 100000
        const sdx3 = iwd2 * 43388 / 100000
        const sx1 = hc - sdx1
        const sx2 = hc - sdx2
        const sx3 = hc - sdx3
        const sx4 = hc + sdx3
        const sx5 = hc + sdx2
        const sx6 = hc + sdx1
        const sdy1 = ihd2 * 90097 / 100000
        const sdy2 = ihd2 * 22252 / 100000
        const sdy3 = ihd2 * 62349 / 100000
        const sy1 = svc - sdy1
        const sy2 = svc - sdy2
        const sy3 = svc + sdy3
        const sy4 = svc + ihd2
        pathData = `M ${x1},${y2} L ${sx1},${sy2} L ${x2},${y1} L ${sx3},${sy1} L ${hc},0 L ${sx4},${sy1} L ${x5},${y1} L ${sx6},${sy2} L ${x6},${y2} L ${sx5},${sy3} L ${x4},${y3} L ${hc},${sy4} L ${x3},${y3} L ${sx2},${sy3} z`
      }
      break
    case 'star8':
      {
        const hc = w / 2,
          vc = h / 2,
          wd2 = w / 2,
          hd2 = h / 2
        let adj = 37500 * RATIO_EMUs_Points
        const maxAdj = 50000 * RATIO_EMUs_Points
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        if (shapAdjst) {
          const name = shapAdjst['attrs']['name']
          if (name === 'adj') {
            adj = parseInt(shapAdjst['attrs']['fmla'].substring(4)) * RATIO_EMUs_Points
          }
        }
        const a = (adj < 0) ? 0 : (adj > maxAdj) ? maxAdj : adj
        const dx1 = wd2 * Math.cos(0.7853981634)
        const x1 = hc - dx1
        const x2 = hc + dx1
        const dy1 = hd2 * Math.sin(0.7853981634)
        const y1 = vc - dy1
        const y2 = vc + dy1
        const iwd2 = wd2 * a / maxAdj
        const ihd2 = hd2 * a / maxAdj
        const sdx1 = iwd2 * 92388 / 100000
        const sdx2 = iwd2 * 38268 / 100000
        const sdy1 = ihd2 * 92388 / 100000
        const sdy2 = ihd2 * 38268 / 100000
        const sx1 = hc - sdx1
        const sx2 = hc - sdx2
        const sx3 = hc + sdx2
        const sx4 = hc + sdx1
        const sy1 = vc - sdy1
        const sy2 = vc - sdy2
        const sy3 = vc + sdy2
        const sy4 = vc + sdy1
        pathData = `M 0,${vc} L ${sx1},${sy2} L ${x1},${y1} L ${sx2},${sy1} L ${hc},0 L ${sx3},${sy1} L ${x2},${y1} L ${sx4},${sy2} L ${w},${vc} L ${sx4},${sy3} L ${x2},${y2} L ${sx3},${sy4} L ${hc},${h} L ${sx2},${sy4} L ${x1},${y2} L ${sx1},${sy3} z`
      }
      break
    case 'star10':
      {
        const hc = w / 2,
          vc = h / 2,
          wd2 = w / 2,
          hd2 = h / 2
        let adj = 42533 * RATIO_EMUs_Points
        let hf = 105146 * RATIO_EMUs_Points
        const maxAdj = 50000 * RATIO_EMUs_Points
        const cnstVal1 = 100000 * RATIO_EMUs_Points
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        if (shapAdjst) {
          Object.keys(shapAdjst).forEach(key => {
            const name = shapAdjst[key]['attrs']['name']
            if (name === 'adj') {
              adj = parseInt(shapAdjst[key]['attrs']['fmla'].substring(4)) * RATIO_EMUs_Points
            } 
            else if (name === 'hf') {
              hf = parseInt(shapAdjst[key]['attrs']['fmla'].substring(4)) * RATIO_EMUs_Points
            }
          })
        }
        const a = (adj < 0) ? 0 : (adj > maxAdj) ? maxAdj : adj
        const swd2 = wd2 * hf / cnstVal1
        const dx1 = swd2 * 95106 / 100000
        const dx2 = swd2 * 58779 / 100000
        const x1 = hc - dx1
        const x2 = hc - dx2
        const x3 = hc + dx2
        const x4 = hc + dx1
        const dy1 = hd2 * 80902 / 100000
        const dy2 = hd2 * 30902 / 100000
        const y1 = vc - dy1
        const y2 = vc - dy2
        const y3 = vc + dy2
        const y4 = vc + dy1
        const iwd2 = swd2 * a / maxAdj
        const ihd2 = hd2 * a / maxAdj
        const sdx1 = iwd2 * 80902 / 100000
        const sdx2 = iwd2 * 30902 / 100000
        const sdy1 = ihd2 * 95106 / 100000
        const sdy2 = ihd2 * 58779 / 100000
        const sx1 = hc - iwd2
        const sx2 = hc - sdx1
        const sx3 = hc - sdx2
        const sx4 = hc + sdx2
        const sx5 = hc + sdx1
        const sx6 = hc + iwd2
        const sy1 = vc - sdy1
        const sy2 = vc - sdy2
        const sy3 = vc + sdy2
        const sy4 = vc + sdy1
        pathData = `M ${x1},${y2} L ${sx2},${sy2} L ${x2},${y1} L ${sx3},${sy1} L ${hc},0 L ${sx4},${sy1} L ${x3},${y1} L ${sx5},${sy2} L ${x4},${y2} L ${sx6},${vc} L ${x4},${y3} L ${sx5},${sy3} L ${x3},${y4} L ${sx4},${sy4} L ${hc},${h} L ${sx3},${sy4} L ${x2},${y4} L ${sx2},${sy3} L ${x1},${y3} L ${sx1},${vc} z`
      }
      break
    case 'star12':
      {
        const hc = w / 2,
          vc = h / 2,
          wd2 = w / 2,
          hd2 = h / 2,
          hd4 = h / 4,
          wd4 = w / 4
        let adj = 37500 * RATIO_EMUs_Points
        const maxAdj = 50000 * RATIO_EMUs_Points
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        if (shapAdjst) {
          const name = shapAdjst['attrs']['name']
          if (name === 'adj') {
            adj = parseInt(shapAdjst['attrs']['fmla'].substring(4)) * RATIO_EMUs_Points
          }
        }
        const a = (adj < 0) ? 0 : (adj > maxAdj) ? maxAdj : adj
        const dx1 = wd2 * Math.cos(0.5235987756)
        const dy1 = hd2 * Math.sin(1.0471975512)
        const x1 = hc - dx1
        const x3 = w * 3 / 4
        const x4 = hc + dx1
        const y1 = vc - dy1
        const y3 = h * 3 / 4
        const y4 = vc + dy1
        const iwd2 = wd2 * a / maxAdj
        const ihd2 = hd2 * a / maxAdj
        const sdx1 = iwd2 * Math.cos(0.2617993878)
        const sdx2 = iwd2 * Math.cos(0.7853981634)
        const sdx3 = iwd2 * Math.cos(1.308996939)
        const sdy1 = ihd2 * Math.sin(1.308996939)
        const sdy2 = ihd2 * Math.sin(0.7853981634)
        const sdy3 = ihd2 * Math.sin(0.2617993878)
        const sx1 = hc - sdx1
        const sx2 = hc - sdx2
        const sx3 = hc - sdx3
        const sx4 = hc + sdx3
        const sx5 = hc + sdx2
        const sx6 = hc + sdx1
        const sy1 = vc - sdy1
        const sy2 = vc - sdy2
        const sy3 = vc - sdy3
        const sy4 = vc + sdy3
        const sy5 = vc + sdy2
        const sy6 = vc + sdy1
        pathData = `M 0,${vc} L ${sx1},${sy3} L ${x1},${hd4} L ${sx2},${sy2} L ${wd4},${y1} L ${sx3},${sy1} L ${hc},0 L ${sx4},${sy1} L ${x3},${y1} L ${sx5},${sy2} L ${x4},${hd4} L ${sx6},${sy3} L ${w},${vc} L ${sx6},${sy4} L ${x4},${y3} L ${sx5},${sy5} L ${x3},${y4} L ${sx4},${sy6} L ${hc},${h} L ${sx3},${sy6} L ${wd4},${y4} L ${sx2},${sy5} L ${x1},${y3} L ${sx1},${sy4} z`
      }
      break
    case 'star16':
      {
        const hc = w / 2,
          vc = h / 2,
          wd2 = w / 2,
          hd2 = h / 2
        let adj = 37500 * RATIO_EMUs_Points
        const maxAdj = 50000 * RATIO_EMUs_Points
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        if (shapAdjst) {
          const name = shapAdjst['attrs']['name']
          if (name === 'adj') {
            adj = parseInt(shapAdjst['attrs']['fmla'].substring(4)) * RATIO_EMUs_Points
          }
        }
        const a = (adj < 0) ? 0 : (adj > maxAdj) ? maxAdj : adj
        const dx1 = wd2 * 92388 / 100000
        const dx2 = wd2 * 70711 / 100000
        const dx3 = wd2 * 38268 / 100000
        const dy1 = hd2 * 92388 / 100000
        const dy2 = hd2 * 70711 / 100000
        const dy3 = hd2 * 38268 / 100000
        const x1 = hc - dx1
        const x2 = hc - dx2
        const x3 = hc - dx3
        const x4 = hc + dx3
        const x5 = hc + dx2
        const x6 = hc + dx1
        const y1 = vc - dy1
        const y2 = vc - dy2
        const y3 = vc - dy3
        const y4 = vc + dy3
        const y5 = vc + dy2
        const y6 = vc + dy1
        const iwd2 = wd2 * a / maxAdj
        const ihd2 = hd2 * a / maxAdj
        const sdx1 = iwd2 * 98079 / 100000
        const sdx2 = iwd2 * 83147 / 100000
        const sdx3 = iwd2 * 55557 / 100000
        const sdx4 = iwd2 * 19509 / 100000
        const sdy1 = ihd2 * 98079 / 100000
        const sdy2 = ihd2 * 83147 / 100000
        const sdy3 = ihd2 * 55557 / 100000
        const sdy4 = ihd2 * 19509 / 100000
        const sx1 = hc - sdx1
        const sx2 = hc - sdx2
        const sx3 = hc - sdx3
        const sx4 = hc - sdx4
        const sx5 = hc + sdx4
        const sx6 = hc + sdx3
        const sx7 = hc + sdx2
        const sx8 = hc + sdx1
        const sy1 = vc - sdy1
        const sy2 = vc - sdy2
        const sy3 = vc - sdy3
        const sy4 = vc - sdy4
        const sy5 = vc + sdy4
        const sy6 = vc + sdy3
        const sy7 = vc + sdy2
        const sy8 = vc + sdy1
        pathData = `M 0,${vc} L ${sx1},${sy4} L ${x1},${y3} L ${sx2},${sy3} L ${x2},${y2} L ${sx3},${sy2} L ${x3},${y1} L ${sx4},${sy1} L ${hc},0 L ${sx5},${sy1} L ${x4},${y1} L ${sx6},${sy2} L ${x5},${y2} L ${sx7},${sy3} L ${x6},${y3} L ${sx8},${sy4} L ${w},${vc} L ${sx8},${sy5} L ${x6},${y4} L ${sx7},${sy6} L ${x5},${y5} L ${sx6},${sy7} L ${x4},${y6} L ${sx5},${sy8} L ${hc},${h} L ${sx4},${sy8} L ${x3},${y6} L ${sx3},${sy7} L ${x2},${y5} L ${sx2},${sy6} L ${x1},${y4} L ${sx1},${sy5} z`
      }
      break
    case 'star24':
      {
        const hc = w / 2,
          vc = h / 2,
          wd2 = w / 2,
          hd2 = h / 2,
          hd4 = h / 4,
          wd4 = w / 4
        let adj = 37500 * RATIO_EMUs_Points
        const maxAdj = 50000 * RATIO_EMUs_Points
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        if (shapAdjst) {
          const name = shapAdjst['attrs']['name']
          if (name === 'adj') {
            adj = parseInt(shapAdjst['attrs']['fmla'].substring(4)) * RATIO_EMUs_Points
          }
        }
        const a = (adj < 0) ? 0 : (adj > maxAdj) ? maxAdj : adj
        const dx1 = wd2 * Math.cos(0.2617993878)
        const dx2 = wd2 * Math.cos(0.5235987756)
        const dx3 = wd2 * Math.cos(0.7853981634)
        const dx4 = wd4
        const dx5 = wd2 * Math.cos(1.308996939)
        const dy1 = hd2 * Math.sin(1.308996939)
        const dy2 = hd2 * Math.sin(1.0471975512)
        const dy3 = hd2 * Math.sin(0.7853981634)
        const dy4 = hd4
        const dy5 = hd2 * Math.sin(0.2617993878)
        const x1 = hc - dx1
        const x2 = hc - dx2
        const x3 = hc - dx3
        const x4 = hc - dx4
        const x5 = hc - dx5
        const x6 = hc + dx5
        const x7 = hc + dx4
        const x8 = hc + dx3
        const x9 = hc + dx2
        const x10 = hc + dx1
        const y1 = vc - dy1
        const y2 = vc - dy2
        const y3 = vc - dy3
        const y4 = vc - dy4
        const y5 = vc - dy5
        const y6 = vc + dy5
        const y7 = vc + dy4
        const y8 = vc + dy3
        const y9 = vc + dy2
        const y10 = vc + dy1
        const iwd2 = wd2 * a / maxAdj
        const ihd2 = hd2 * a / maxAdj
        const sdx1 = iwd2 * 99144 / 100000
        const sdx2 = iwd2 * 92388 / 100000
        const sdx3 = iwd2 * 79335 / 100000
        const sdx4 = iwd2 * 60876 / 100000
        const sdx5 = iwd2 * 38268 / 100000
        const sdx6 = iwd2 * 13053 / 100000
        const sdy1 = ihd2 * 99144 / 100000
        const sdy2 = ihd2 * 92388 / 100000
        const sdy3 = ihd2 * 79335 / 100000
        const sdy4 = ihd2 * 60876 / 100000
        const sdy5 = ihd2 * 38268 / 100000
        const sdy6 = ihd2 * 13053 / 100000
        const sx1 = hc - sdx1
        const sx2 = hc - sdx2
        const sx3 = hc - sdx3
        const sx4 = hc - sdx4
        const sx5 = hc - sdx5
        const sx6 = hc - sdx6
        const sx7 = hc + sdx6
        const sx8 = hc + sdx5
        const sx9 = hc + sdx4
        const sx10 = hc + sdx3
        const sx11 = hc + sdx2
        const sx12 = hc + sdx1
        const sy1 = vc - sdy1
        const sy2 = vc - sdy2
        const sy3 = vc - sdy3
        const sy4 = vc - sdy4
        const sy5 = vc - sdy5
        const sy6 = vc - sdy6
        const sy7 = vc + sdy6
        const sy8 = vc + sdy5
        const sy9 = vc + sdy4
        const sy10 = vc + sdy3
        const sy11 = vc + sdy2
        const sy12 = vc + sdy1
        pathData = `M 0,${vc} L ${sx1},${sy6} L ${x1},${y5} L ${sx2},${sy5} L ${x2},${y4} L ${sx3},${sy4} L ${x3},${y3} L ${sx4},${sy3} L ${x4},${y2} L ${sx5},${sy2} L ${x5},${y1} L ${sx6},${sy1} L ${hc},0 L ${sx7},${sy1} L ${x6},${y1} L ${sx8},${sy2} L ${x7},${y2} L ${sx9},${sy3} L ${x8},${y3} L ${sx10},${sy4} L ${x9},${y4} L ${sx11},${sy5} L ${x10},${y5} L ${sx12},${sy6} L ${w},${vc} L ${sx12},${sy7} L ${x10},${y6} L ${sx11},${sy8} L ${x9},${y7} L ${sx10},${sy9} L ${x8},${y8} L ${sx9},${sy10} L ${x7},${y9} L ${sx8},${sy11} L ${x6},${y10} L ${sx7},${sy12} L ${hc},${h} L ${sx6},${sy12} L ${x5},${y10} L ${sx5},${sy11} L ${x4},${y9} L ${sx4},${sy10} L ${x3},${y8} L ${sx3},${sy9} L ${x2},${y7} L ${sx2},${sy8} L ${x1},${y6} L ${sx1},${sy7} z`
      }
      break
    case 'star32':
      {
        const hc = w / 2,
          vc = h / 2,
          wd2 = w / 2,
          hd2 = h / 2
        let adj = 37500 * RATIO_EMUs_Points
        const maxAdj = 50000 * RATIO_EMUs_Points
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        if (shapAdjst) {
          const name = shapAdjst['attrs']['name']
          if (name === 'adj') {
            adj = parseInt(shapAdjst['attrs']['fmla'].substring(4)) * RATIO_EMUs_Points
          }
        }
        const a = (adj < 0) ? 0 : (adj > maxAdj) ? maxAdj : adj
        const dx1 = wd2 * 98079 / 100000
        const dx2 = wd2 * 92388 / 100000
        const dx3 = wd2 * 83147 / 100000
        const dx4 = wd2 * Math.cos(0.7853981634)
        const dx5 = wd2 * 55557 / 100000
        const dx6 = wd2 * 38268 / 100000
        const dx7 = wd2 * 19509 / 100000
        const dy1 = hd2 * 98079 / 100000
        const dy2 = hd2 * 92388 / 100000
        const dy3 = hd2 * 83147 / 100000
        const dy4 = hd2 * Math.sin(0.7853981634)
        const dy5 = hd2 * 55557 / 100000
        const dy6 = hd2 * 38268 / 100000
        const dy7 = hd2 * 19509 / 100000
        const x1 = hc - dx1
        const x2 = hc - dx2
        const x3 = hc - dx3
        const x4 = hc - dx4
        const x5 = hc - dx5
        const x6 = hc - dx6
        const x7 = hc - dx7
        const x8 = hc + dx7
        const x9 = hc + dx6
        const x10 = hc + dx5
        const x11 = hc + dx4
        const x12 = hc + dx3
        const x13 = hc + dx2
        const x14 = hc + dx1
        const y1 = vc - dy1
        const y2 = vc - dy2
        const y3 = vc - dy3
        const y4 = vc - dy4
        const y5 = vc - dy5
        const y6 = vc - dy6
        const y7 = vc - dy7
        const y8 = vc + dy7
        const y9 = vc + dy6
        const y10 = vc + dy5
        const y11 = vc + dy4
        const y12 = vc + dy3
        const y13 = vc + dy2
        const y14 = vc + dy1
        const iwd2 = wd2 * a / maxAdj
        const ihd2 = hd2 * a / maxAdj
        const sdx1 = iwd2 * 99518 / 100000
        const sdx2 = iwd2 * 95694 / 100000
        const sdx3 = iwd2 * 88192 / 100000
        const sdx4 = iwd2 * 77301 / 100000
        const sdx5 = iwd2 * 63439 / 100000
        const sdx6 = iwd2 * 47140 / 100000
        const sdx7 = iwd2 * 29028 / 100000
        const sdx8 = iwd2 * 9802 / 100000
        const sdy1 = ihd2 * 99518 / 100000
        const sdy2 = ihd2 * 95694 / 100000
        const sdy3 = ihd2 * 88192 / 100000
        const sdy4 = ihd2 * 77301 / 100000
        const sdy5 = ihd2 * 63439 / 100000
        const sdy6 = ihd2 * 47140 / 100000
        const sdy7 = ihd2 * 29028 / 100000
        const sdy8 = ihd2 * 9802 / 100000
        const sx1 = hc - sdx1
        const sx2 = hc - sdx2
        const sx3 = hc - sdx3
        const sx4 = hc - sdx4
        const sx5 = hc - sdx5
        const sx6 = hc - sdx6
        const sx7 = hc - sdx7
        const sx8 = hc - sdx8
        const sx9 = hc + sdx8
        const sx10 = hc + sdx7
        const sx11 = hc + sdx6
        const sx12 = hc + sdx5
        const sx13 = hc + sdx4
        const sx14 = hc + sdx3
        const sx15 = hc + sdx2
        const sx16 = hc + sdx1
        const sy1 = vc - sdy1
        const sy2 = vc - sdy2
        const sy3 = vc - sdy3
        const sy4 = vc - sdy4
        const sy5 = vc - sdy5
        const sy6 = vc - sdy6
        const sy7 = vc - sdy7
        const sy8 = vc - sdy8
        const sy9 = vc + sdy8
        const sy10 = vc + sdy7
        const sy11 = vc + sdy6
        const sy12 = vc + sdy5
        const sy13 = vc + sdy4
        const sy14 = vc + sdy3
        const sy15 = vc + sdy2
        const sy16 = vc + sdy1
        pathData = `M 0,${vc} L ${sx1},${sy8} L ${x1},${y7} L ${sx2},${sy7} L ${x2},${y6} L ${sx3},${sy6} L ${x3},${y5} L ${sx4},${sy5} L ${x4},${y4} L ${sx5},${sy4} L ${x5},${y3} L ${sx6},${sy3} L ${x6},${y2} L ${sx7},${sy2} L ${x7},${y1} L ${sx8},${sy1} L ${hc},0 L ${sx9},${sy1} L ${x8},${y1} L ${sx10},${sy2} L ${x9},${y2} L ${sx11},${sy3} L ${x10},${y3} L ${sx12},${sy4} L ${x11},${y4} L ${sx13},${sy5} L ${x12},${y5} L ${sx14},${sy6} L ${x13},${y6} L ${sx15},${sy7} L ${x14},${y7} L ${sx16},${sy8} L ${w},${vc} L ${sx16},${sy9} L ${x14},${y8} L ${sx15},${sy10} L ${x13},${y9} L ${sx14},${sy11} L ${x12},${y10} L ${sx13},${sy12} L ${x11},${y11} L ${sx12},${sy13} L ${x10},${y12} L ${sx11},${sy14} L ${x9},${y13} L ${sx10},${sy15} L ${x8},${y14} L ${sx9},${sy16} L ${hc},${h} L ${sx8},${sy16} L ${x7},${y14} L ${sx7},${sy15} L ${x6},${y13} L ${sx6},${sy14} L ${x5},${y12} L ${sx5},${sy13} L ${x4},${y11} L ${sx4},${sy12} L ${x3},${y10} L ${sx3},${sy11} L ${x2},${y9} L ${sx2},${sy10} L ${x1},${y8} L ${sx1},${sy9} z`
      }
      break
    case 'pie':
    case 'pieWedge':
    case 'arc':
      {
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let adj1, adj2, H, isClose

        if (shapType === 'pie') {
          adj1 = 0
          adj2 = 270
          H = h
          isClose = true
        } 
        else if (shapType === 'pieWedge') {
          adj1 = 180
          adj2 = 270
          H = 2 * h
          isClose = true
        } 
        else if (shapType === 'arc') {
          adj1 = 270
          adj2 = 0
          H = h
          isClose = false
        }

        if (shapAdjst) {
          let shapAdjst1 = getTextByPathList(shapAdjst, ['attrs', 'fmla'])
          let shapAdjst2 = shapAdjst1
          if (shapAdjst1 === undefined) {
            shapAdjst1 = shapAdjst[0]['attrs']['fmla']
            shapAdjst2 = shapAdjst[1]['attrs']['fmla']
          }
          if (shapAdjst1) {
            adj1 = parseInt(shapAdjst1.substring(4)) / 60000
          }
          if (shapAdjst2) {
            adj2 = parseInt(shapAdjst2.substring(4)) / 60000
          }
        }

        pathData = shapePie(H, w, adj1, adj2, isClose)
      }
      break
    case 'chord':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let sAdj1_val = 45
        let sAdj2_val = 270
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              const sAdj1 = getTextByPathList(adj, ['attrs', 'fmla'])
              sAdj1_val = parseInt(sAdj1.substring(4)) / 60000
            } 
            else if (sAdj_name === 'adj2') {
              const sAdj2 = getTextByPathList(adj, ['attrs', 'fmla'])
              sAdj2_val = parseInt(sAdj2.substring(4)) / 60000
            }
          }
        }
        const hR = h / 2
        const wR = w / 2
        pathData = shapeArc(wR, hR, wR, hR, sAdj1_val, sAdj2_val, true)
      }
      break
    case 'frame':
      {
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd', 'attrs', 'fmla'])
        let adj1 = 12500 * RATIO_EMUs_Points
        const cnstVal1 = 50000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        if (shapAdjst) {
          adj1 = parseInt(shapAdjst.substring(4)) * RATIO_EMUs_Points
        }
        const a1 = (adj1 < 0) ? 0 : (adj1 > cnstVal1) ? cnstVal1 : adj1
        const x1 = Math.min(w, h) * a1 / cnstVal2
        const x4 = w - x1
        const y4 = h - x1
        pathData = `M 0,0 L ${w},0 L ${w},${h} L 0,${h} z M ${x1},${x1} L ${x1},${y4} L ${x4},${y4} L ${x4},${x1} z`
      }
      break
    case 'donut':
      {
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd', 'attrs', 'fmla'])
        let adj = 25000 * RATIO_EMUs_Points
        const cnstVal1 = 50000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        if (shapAdjst) {
          adj = parseInt(shapAdjst.substring(4)) * RATIO_EMUs_Points
        }
        const a = (adj < 0) ? 0 : (adj > cnstVal1) ? cnstVal1 : adj
        const dr = Math.min(w, h) * a / cnstVal2
        const iwd2 = w / 2 - dr
        const ihd2 = h / 2 - dr
        const outerPath = `M ${w / 2 - w / 2},${h / 2} A ${w / 2},${h / 2} 0 1,0 ${w / 2 + w / 2},${h / 2} A ${w / 2},${h / 2} 0 1,0 ${w / 2 - w / 2},${h / 2} Z`
        const innerPath = `M ${w / 2 + iwd2},${h / 2} A ${iwd2},${ihd2} 0 1,0 ${w / 2 - iwd2},${h / 2} A ${iwd2},${ihd2} 0 1,0 ${w / 2 + iwd2},${h / 2} Z`
        pathData = `${outerPath} ${innerPath}`
      }
      break
    case 'noSmoking':
      {
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd', 'attrs', 'fmla'])
        let adj = 18750 * RATIO_EMUs_Points
        const cnstVal1 = 50000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        if (shapAdjst) {
          adj = parseInt(shapAdjst.substring(4)) * RATIO_EMUs_Points
        }
        const a = (adj < 0) ? 0 : (adj > cnstVal1) ? cnstVal1 : adj
        const dr = Math.min(w, h) * a / cnstVal2
        const iwd2 = w / 2 - dr
        const ihd2 = h / 2 - dr
        const ang = Math.atan(h / w)
        const ct = ihd2 * Math.cos(ang)
        const st = iwd2 * Math.sin(ang)
        const m = Math.sqrt(ct * ct + st * st)
        const n = iwd2 * ihd2 / m
        const drd2 = dr / 2
        const dang = Math.atan(drd2 / n)
        const swAng = -Math.PI + (dang * 2)
        const stAng1 = ang - dang
        const stAng2 = stAng1 - Math.PI
        const ct1 = ihd2 * Math.cos(stAng1)
        const st1 = iwd2 * Math.sin(stAng1)
        const m1 = Math.sqrt(ct1 * ct1 + st1 * st1)
        const n1 = iwd2 * ihd2 / m1
        const dx1 = n1 * Math.cos(stAng1)
        const dy1 = n1 * Math.sin(stAng1)
        const x1 = w / 2 + dx1
        const y1 = h / 2 + dy1
        const x2 = w / 2 - dx1
        const y2 = h / 2 - dy1
        const stAng1deg = stAng1 * 180 / Math.PI
        const stAng2deg = stAng2 * 180 / Math.PI
        const swAng2deg = swAng * 180 / Math.PI
        const outerCircle = `M ${w / 2 - w / 2},${h / 2} A ${w / 2},${h / 2} 0 1,0 ${w / 2 + w / 2},${h / 2} A ${w / 2},${h / 2} 0 1,0 ${w / 2 - w / 2},${h / 2} Z`
        const slash1 = `M ${x1},${y1} ${shapeArc(w / 2, h / 2, iwd2, ihd2, stAng1deg, (stAng1deg + swAng2deg), false).replace('M', 'L')} z`
        const slash2 = `M ${x2},${y2} ${shapeArc(w / 2, h / 2, iwd2, ihd2, stAng2deg, (stAng2deg + swAng2deg), false).replace('M', 'L')} z`
        pathData = `${outerCircle} ${slash1} ${slash2}`
      }
      break
    case 'halfFrame':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let sAdj1_val = 3.5
        let sAdj2_val = 3.5
        const cnsVal = 100000 * RATIO_EMUs_Points
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              sAdj1_val = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            } 
            else if (sAdj_name === 'adj2') {
              sAdj2_val = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
          }
        }
        const minWH = Math.min(w, h)
        const maxAdj2 = (cnsVal * w) / minWH
        const a2 = (sAdj2_val < 0) ? 0 : (sAdj2_val > maxAdj2) ? maxAdj2 : sAdj2_val
        const x1 = (minWH * a2) / cnsVal
        const g2 = h - (h * x1 / w)
        const maxAdj1 = (cnsVal * g2) / minWH
        const a1 = (sAdj1_val < 0) ? 0 : (sAdj1_val > maxAdj1) ? maxAdj1 : sAdj1_val
        const y1 = minWH * a1 / cnsVal
        const x2 = w - (y1 * w / h)
        const y2 = h - (x1 * h / w)
        pathData = `M 0,0 L ${w},0 L ${x2},${y1} L ${x1},${y1} L ${x1},${y2} L 0,${h} z`
      }
      break
    case 'blockArc':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let adj1 = 180
        let adj2 = 0
        let adj3 = 25000 * RATIO_EMUs_Points
        const cnstVal1 = 50000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) / 60000
            } 
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) / 60000
            } 
            else if (sAdj_name === 'adj3') {
              adj3 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
          }
        }
        const cd1 = 360
        const stAng = (adj1 < 0) ? 0 : (adj1 > cd1) ? cd1 : adj1
        const istAng = (adj2 < 0) ? 0 : (adj2 > cd1) ? cd1 : adj2
        const a3 = (adj3 < 0) ? 0 : (adj3 > cnstVal1) ? cnstVal1 : adj3
        const sw11 = istAng - stAng
        const sw12 = sw11 + cd1
        const swAng = (sw11 > 0) ? sw11 : sw12
        const iswAng = -swAng
        const endAng = stAng + swAng
        const iendAng = istAng + iswAng
        const stRd = stAng * (Math.PI) / 180
        const istRd = istAng * (Math.PI) / 180
        const wd2 = w / 2
        const hd2 = h / 2
        const hc = w / 2
        const vc = h / 2
        let x1, y1
        if (stAng > 90 && stAng < 270) {
          const wt1 = wd2 * (Math.sin((Math.PI) / 2 - stRd))
          const ht1 = hd2 * (Math.cos((Math.PI) / 2 - stRd))
          const dx1 = wd2 * (Math.cos(Math.atan(ht1 / wt1)))
          const dy1 = hd2 * (Math.sin(Math.atan(ht1 / wt1)))
          x1 = hc - dx1
          y1 = vc - dy1
        } 
        else {
          const wt1 = wd2 * (Math.sin(stRd))
          const ht1 = hd2 * (Math.cos(stRd))
          const dx1 = wd2 * (Math.cos(Math.atan(wt1 / ht1)))
          const dy1 = hd2 * (Math.sin(Math.atan(wt1 / ht1)))
          x1 = hc + dx1
          y1 = vc + dy1
        }
        const dr = Math.min(w, h) * a3 / cnstVal2
        const iwd2 = wd2 - dr
        const ihd2 = hd2 - dr
        let x2, y2
        if ((endAng <= 450 && endAng > 270) || ((endAng >= 630 && endAng < 720))) {
          const wt2 = iwd2 * (Math.sin(istRd))
          const ht2 = ihd2 * (Math.cos(istRd))
          const dx2 = iwd2 * (Math.cos(Math.atan(wt2 / ht2)))
          const dy2 = ihd2 * (Math.sin(Math.atan(wt2 / ht2)))
          x2 = hc + dx2
          y2 = vc + dy2
        } 
        else {
          const wt2 = iwd2 * (Math.sin((Math.PI) / 2 - istRd))
          const ht2 = ihd2 * (Math.cos((Math.PI) / 2 - istRd))
          const dx2 = iwd2 * (Math.cos(Math.atan(ht2 / wt2)))
          const dy2 = ihd2 * (Math.sin(Math.atan(ht2 / wt2)))
          x2 = hc - dx2
          y2 = vc - dy2
        }
        pathData = `M ${x1},${y1} ${shapeArc(wd2, hd2, wd2, hd2, stAng, endAng, false).replace('M', 'L')} L ${x2},${y2} ${shapeArc(wd2, hd2, iwd2, ihd2, istAng, iendAng, false).replace('M', 'L')} z`
      }
      break
    case 'bracePair':
      {
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd', 'attrs', 'fmla'])
        let adj = 8333 * RATIO_EMUs_Points
        const cnstVal1 = 25000 * RATIO_EMUs_Points
        const cnstVal2 = 50000 * RATIO_EMUs_Points
        const cnstVal3 = 100000 * RATIO_EMUs_Points
        if (shapAdjst) {
          adj = parseInt(shapAdjst.substring(4)) * RATIO_EMUs_Points
        }
        const vc = h / 2,
          cd2 = 180,
          cd4 = 90,
          c3d4 = 270
        const a = (adj < 0) ? 0 : (adj > cnstVal1) ? cnstVal1 : adj
        const minWH = Math.min(w, h)
        const x1 = minWH * a / cnstVal3
        const x2 = minWH * a / cnstVal2
        const x3 = w - x2
        const x4 = w - x1
        const y2 = vc - x1
        const y3 = vc + x1
        const y4 = h - x1
        pathData = `M ${x2},${h} ${shapeArc(x2, y4, x1, x1, cd4, cd2, false).replace('M', 'L')} L ${x1},${y3} ${shapeArc(0, y3, x1, x1, 0, (-cd4), false).replace('M', 'L')} ${shapeArc(0, y2, x1, x1, cd4, 0, false).replace('M', 'L')} L ${x1},${x1} ${shapeArc(x2, x1, x1, x1, cd2, c3d4, false).replace('M', 'L')} M ${x3},0 ${shapeArc(x3, x1, x1, x1, c3d4, 360, false).replace('M', 'L')} L ${x4},${y2} ${shapeArc(w, y2, x1, x1, cd2, cd4, false).replace('M', 'L')} ${shapeArc(w, y3, x1, x1, c3d4, cd2, false).replace('M', 'L')} L ${x4},${y4} ${shapeArc(x3, y4, x1, x1, 0, cd4, false).replace('M', 'L')}`
      }
      break
    case 'leftBrace':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let adj1 = 8333 * RATIO_EMUs_Points
        let adj2 = 50000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            } 
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
          }
        }
        const cd2 = 180,
          cd4 = 90,
          c3d4 = 270
        const a2 = (adj2 < 0) ? 0 : (adj2 > cnstVal2) ? cnstVal2 : adj2
        const minWH = Math.min(w, h)
        const q1 = cnstVal2 - a2
        const q2 = (q1 < a2) ? q1 : a2
        const q3 = q2 / 2
        const maxAdj1 = q3 * h / minWH
        const a1 = (adj1 < 0) ? 0 : (adj1 > maxAdj1) ? maxAdj1 : adj1
        const y1 = minWH * a1 / cnstVal2
        const y3 = h * a2 / cnstVal2
        const y2 = y3 - y1
        const y4 = y3 + y1
        pathData = `M ${w},${h} ${shapeArc(w, h - y1, w / 2, y1, cd4, cd2, false).replace('M', 'L')} L ${w / 2},${y4} ${shapeArc(0, y4, w / 2, y1, 0, (-cd4), false).replace('M', 'L')} ${shapeArc(0, y2, w / 2, y1, cd4, 0, false).replace('M', 'L')} L ${w / 2},${y1} ${shapeArc(w, y1, w / 2, y1, cd2, c3d4, false).replace('M', 'L')}`
      }
      break
    case 'rightBrace':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let adj1 = 8333 * RATIO_EMUs_Points
        let adj2 = 50000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            } 
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
          }
        }
        const cd = 360,
          cd2 = 180,
          cd4 = 90,
          c3d4 = 270
        const a2 = (adj2 < 0) ? 0 : (adj2 > cnstVal2) ? cnstVal2 : adj2
        const minWH = Math.min(w, h)
        const q1 = cnstVal2 - a2
        const q2 = (q1 < a2) ? q1 : a2
        const q3 = q2 / 2
        const maxAdj1 = q3 * h / minWH
        const a1 = (adj1 < 0) ? 0 : (adj1 > maxAdj1) ? maxAdj1 : adj1
        const y1 = minWH * a1 / cnstVal2
        const y3 = h * a2 / cnstVal2
        const y2 = y3 - y1
        const y4 = h - y1
        pathData = `M 0,0 ${shapeArc(0, y1, w / 2, y1, c3d4, cd, false).replace('M', 'L')} L ${w / 2},${y2} ${shapeArc(w, y2, w / 2, y1, cd2, cd4, false).replace('M', 'L')} ${shapeArc(w, y3 + y1, w / 2, y1, c3d4, cd2, false).replace('M', 'L')} L ${w / 2},${y4} ${shapeArc(0, y4, w / 2, y1, 0, cd4, false).replace('M', 'L')}`
      }
      break
    case 'bracketPair':
      {
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd', 'attrs', 'fmla'])
        let adj = 16667 * RATIO_EMUs_Points
        const cnstVal1 = 50000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        if (shapAdjst) {
          adj = parseInt(shapAdjst.substring(4)) * RATIO_EMUs_Points
        }
        const cd2 = 180,
          cd4 = 90,
          c3d4 = 270
        const a = (adj < 0) ? 0 : (adj > cnstVal1) ? cnstVal1 : adj
        const x1 = Math.min(w, h) * a / cnstVal2
        const x2 = w - x1
        const y2 = h - x1
        pathData = `${shapeArc(x1, x1, x1, x1, c3d4, cd2, false)} ${shapeArc(x1, y2, x1, x1, cd2, cd4, false).replace('M', 'L')} ${shapeArc(x2, x1, x1, x1, c3d4, (c3d4 + cd4), false)} ${shapeArc(x2, y2, x1, x1, 0, cd4, false).replace('M', 'L')}`
      }
      break
    case 'leftBracket':
      {
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd', 'attrs', 'fmla'])
        let adj = 8333 * RATIO_EMUs_Points
        const cnstVal1 = 50000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        const maxAdj = cnstVal1 * h / Math.min(w, h)
        if (shapAdjst) {
          adj = parseInt(shapAdjst.substring(4)) * RATIO_EMUs_Points
        }
        const cd2 = 180,
          cd4 = 90,
          c3d4 = 270
        const a = (adj < 0) ? 0 : (adj > maxAdj) ? maxAdj : adj
        let y1 = Math.min(w, h) * a / cnstVal2
        if (y1 > w) y1 = w
        const y2 = h - y1
        pathData = `M ${w},${h} ${shapeArc(y1, y2, y1, y1, cd4, cd2, false).replace('M', 'L')} L 0,${y1} ${shapeArc(y1, y1, y1, y1, cd2, c3d4, false).replace('M', 'L')} L ${w},0`
      }
      break
    case 'rightBracket':
      {
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd', 'attrs', 'fmla'])
        let adj = 8333 * RATIO_EMUs_Points
        const cnstVal1 = 50000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        const maxAdj = cnstVal1 * h / Math.min(w, h)
        if (shapAdjst) {
          adj = parseInt(shapAdjst.substring(4)) * RATIO_EMUs_Points
        }
        const cd = 360,
          cd4 = 90,
          c3d4 = 270
        const a = (adj < 0) ? 0 : (adj > maxAdj) ? maxAdj : adj
        const y1 = Math.min(w, h) * a / cnstVal2
        const y2 = h - y1
        const y3 = w - y1
        pathData = `M 0,${h} ${shapeArc(y3, y2, y1, y1, cd4, 0, false).replace('M', 'L')} L ${w},${h / 2} ${shapeArc(y3, y1, y1, y1, cd, c3d4, false).replace('M', 'L')} L 0,0`
      }
      break
    case 'moon':
      {
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd', 'attrs', 'fmla'])
        let adj = 0.5
        if (shapAdjst) {
          adj = parseInt(shapAdjst.substring(4)) / 100000
        }
        const hd2 = h / 2
        const cd2 = 180
        const cd4 = 90
        const adj2 = (1 - adj) * w
        pathData = `M ${w},${h} ${shapeArc(w, hd2, w, hd2, cd4, (cd4 + cd2), false).replace('M', 'L')} ${shapeArc(w, hd2, adj2, hd2, (cd4 + cd2), cd4, false).replace('M', 'L')} z`
      }
      break
    case 'corner':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let sAdj1_val = 50000 * RATIO_EMUs_Points
        let sAdj2_val = 50000 * RATIO_EMUs_Points
        const cnsVal = 100000 * RATIO_EMUs_Points
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              sAdj1_val = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            } 
            else if (sAdj_name === 'adj2') {
              sAdj2_val = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
          }
        }
        const minWH = Math.min(w, h)
        const maxAdj1 = cnsVal * h / minWH
        const maxAdj2 = cnsVal * w / minWH
        const a1 = (sAdj1_val < 0) ? 0 : (sAdj1_val > maxAdj1) ? maxAdj1 : sAdj1_val
        const a2 = (sAdj2_val < 0) ? 0 : (sAdj2_val > maxAdj2) ? maxAdj2 : sAdj2_val
        const x1 = minWH * a2 / cnsVal
        const dy1 = minWH * a1 / cnsVal
        const y1 = h - dy1
        pathData = `M 0,0 L ${x1},0 L ${x1},${y1} L ${w},${y1} L ${w},${h} L 0,${h} z`
      }
      break
    case 'diagStripe':
      {
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd', 'attrs', 'fmla'])
        let sAdj1_val = 50000 * RATIO_EMUs_Points
        const cnsVal = 100000 * RATIO_EMUs_Points
        if (shapAdjst) {
          sAdj1_val = parseInt(shapAdjst.substring(4)) * RATIO_EMUs_Points
        }
        const a1 = (sAdj1_val < 0) ? 0 : (sAdj1_val > cnsVal) ? cnsVal : sAdj1_val
        const x2 = w * a1 / cnsVal
        const y2 = h * a1 / cnsVal
        pathData = `M 0,${y2} L ${x2},0 L ${w},0 L 0,${h} z`
      }
      break
    case 'gear6':
    case 'gear9':
      pathData = shapeGear(w, h / 3.5, parseInt(shapType.substring(4)))
      break
    case 'bentConnector3':
      {
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd', 'attrs', 'fmla'])
        let shapAdjst_val = 0.5
        if (shapAdjst) {
          shapAdjst_val = parseInt(shapAdjst.substring(4)) / 100000
        }
        pathData = `M 0 0 L ${shapAdjst_val * w} 0 L ${shapAdjst_val * w} ${h} L ${w} ${h}`
      }
      break
    case 'plus':
      {
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd', 'attrs', 'fmla'])
        let adj1 = 0.25
        if (shapAdjst) {
          adj1 = parseInt(shapAdjst.substring(4)) / 100000
        }
        const adj2 = (1 - adj1)
        pathData = `M ${adj1 * w} 0 L ${adj1 * w} ${adj1 * h} L 0 ${adj1 * h} L 0 ${adj2 * h} L ${adj1 * w} ${adj2 * h} L ${adj1 * w} ${h} L ${adj2 * w} ${h} L ${adj2 * w} ${adj2 * h} L ${w} ${adj2 * h} L ${w} ${adj1 * h} L ${adj2 * w} ${adj1 * h} L ${adj2 * w} 0 Z`
      }
      break
    case 'teardrop':
      {
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd', 'attrs', 'fmla'])
        let adj1 = 100000 * RATIO_EMUs_Points
        const cnsVal1 = adj1
        const cnsVal2 = 200000 * RATIO_EMUs_Points
        if (shapAdjst) {
          adj1 = parseInt(shapAdjst.substring(4)) * RATIO_EMUs_Points
        }
        const a1 = (adj1 < 0) ? 0 : (adj1 > cnsVal2) ? cnsVal2 : adj1
        const r2 = Math.sqrt(2)
        const tw = r2 * (w / 2)
        const th = r2 * (h / 2)
        const sw = (tw * a1) / cnsVal1
        const sh = (th * a1) / cnsVal1
        const rd45 = (45 * (Math.PI) / 180)
        const dx1 = sw * (Math.cos(rd45))
        const dy1 = sh * (Math.cos(rd45))
        const x1 = (w / 2) + dx1
        const y1 = (h / 2) - dy1
        const x2 = ((w / 2) + x1) / 2
        const y2 = ((h / 2) + y1) / 2
        pathData = `${shapeArc(w / 2, h / 2, w / 2, h / 2, 180, 270, false)} Q ${x2},0 ${x1},${y1} Q ${w},${y2} ${w},${h / 2} ${shapeArc(w / 2, h / 2, w / 2, h / 2, 0, 90, false).replace('M', 'L')} ${shapeArc(w / 2, h / 2, w / 2, h / 2, 90, 180, false).replace('M', 'L')} z`
      }
      break
    case 'plaque':
      {
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd', 'attrs', 'fmla'])
        let adj1 = 16667 * RATIO_EMUs_Points
        const cnsVal1 = 50000 * RATIO_EMUs_Points
        const cnsVal2 = 100000 * RATIO_EMUs_Points
        if (shapAdjst) {
          adj1 = parseInt(shapAdjst.substring(4)) * RATIO_EMUs_Points
        }
        const a1 = (adj1 < 0) ? 0 : (adj1 > cnsVal1) ? cnsVal1 : adj1
        const x1 = a1 * (Math.min(w, h)) / cnsVal2
        const x2 = w - x1
        const y2 = h - x1
        pathData = `M 0,${x1} ${shapeArc(0, 0, x1, x1, 90, 0, false).replace('M', 'L')} L ${x2},0 ${shapeArc(w, 0, x1, x1, 180, 90, false).replace('M', 'L')} L ${w},${y2} ${shapeArc(w, h, x1, x1, 270, 180, false).replace('M', 'L')} L ${x1},${h} ${shapeArc(0, h, x1, x1, 0, -90, false).replace('M', 'L')} z`
      }
      break
    case 'sun':
      {
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd', 'attrs', 'fmla'])
        const refr = RATIO_EMUs_Points
        let adj1 = 25000 * refr
        const cnstVal1 = 12500 * refr
        const cnstVal2 = 46875 * refr
        if (shapAdjst) {
          adj1 = parseInt(shapAdjst.substring(4)) * refr
        }
        const a1 = (adj1 < cnstVal1) ? cnstVal1 : (adj1 > cnstVal2) ? cnstVal2 : adj1
        const cnstVa3 = 50000 * refr
        const cnstVa4 = 100000 * refr
        const g0 = cnstVa3 - a1
        const g1 = g0 * 30274 / 32768
        const g2 = g0 * 12540 / 32768
        const g5 = cnstVa3 - g1
        const g6 = cnstVa3 - g2
        const g10 = g5 * 3 / 4
        const g11 = g6 * 3 / 4
        const g12 = g10 + 3662 * refr
        const g13 = g11 + 36620 * refr
        const g14 = g11 + 12500 * refr
        const g15 = cnstVa4 - g10
        const g16 = cnstVa4 - g12
        const g17 = cnstVa4 - g13
        const g18 = cnstVa4 - g14
        const ox1 = w * 18436 / 21600
        const oy1 = h * 3163 / 21600
        const ox2 = w * 3163 / 21600
        const oy2 = h * 18436 / 21600
        const x10 = w * g10 / cnstVa4
        const x12 = w * g12 / cnstVa4
        const x13 = w * g13 / cnstVa4
        const x14 = w * g14 / cnstVa4
        const x15 = w * g15 / cnstVa4
        const x16 = w * g16 / cnstVa4
        const x17 = w * g17 / cnstVa4
        const x18 = w * g18 / cnstVa4
        const x19 = w * a1 / cnstVa4
        const wR = w * g0 / cnstVa4
        const hR = h * g0 / cnstVa4
        const y10 = h * g10 / cnstVa4
        const y12 = h * g12 / cnstVa4
        const y13 = h * g13 / cnstVa4
        const y14 = h * g14 / cnstVa4
        const y15 = h * g15 / cnstVa4
        const y16 = h * g16 / cnstVa4
        const y17 = h * g17 / cnstVa4
        const y18 = h * g18 / cnstVa4
        pathData = `M ${w},${h / 2} L ${x15},${y18} L ${x15},${y14} z M ${ox1},${oy1} L ${x16},${y17} L ${x13},${y12} z M ${w / 2},0 L ${x18},${y10} L ${x14},${y10} z M ${ox2},${oy1} L ${x17},${y12} L ${x12},${y17} z M 0,${h / 2} L ${x10},${y14} L ${x10},${y18} z M ${ox2},${oy2} L ${x12},${y13} L ${x17},${y16} z M ${w / 2},${h} L ${x14},${y15} L ${x18},${y15} z M ${ox1},${oy2} L ${x13},${y16} L ${x16},${y13} z M ${x19},${h / 2} ${shapeArc(w / 2, h / 2, wR, hR, 180, 540, false).replace('M', 'L')} z`
      }
      break
    case 'heart':
      {
        const dx1 = w * 49 / 48
        const dx2 = w * 10 / 48
        const x1 = w / 2 - dx1
        const x2 = w / 2 - dx2
        const x3 = w / 2 + dx2
        const x4 = w / 2 + dx1
        const y1 = -h / 3
        pathData = `M ${w / 2},${h / 4} C ${x3},${y1} ${x4},${h / 4} ${w / 2},${h} C ${x1},${h / 4} ${x2},${y1} ${w / 2},${h / 4} z`
      }
      break
    case 'lightningBolt':
      {
        const x1 = w * 5022 / 21600,
          x2 = w * 11050 / 21600,
          x3 = w * 8472 / 21600,
          x5 = w * 10012 / 21600,
          x6 = w * 14767 / 21600,
          x7 = w * 12222 / 21600,
          x8 = w * 12860 / 21600,
          x10 = w * 7602 / 21600,
          x11 = w * 16577 / 21600,
          y1 = h * 3890 / 21600,
          y2 = h * 6080 / 21600,
          y3 = h * 6797 / 21600,
          y5 = h * 12877 / 21600,
          y6 = h * 9705 / 21600,
          y7 = h * 12007 / 21600,
          y8 = h * 13987 / 21600,
          y9 = h * 8382 / 21600,
          y11 = h * 14915 / 21600
        pathData = `M ${x3},0 L ${x8},${y2} L ${x2},${y3} L ${x11},${y7} L ${x6},${y5} L ${w},${h} L ${x5},${y11} L ${x7},${y8} L ${x1},${y6} L ${x10},${y9} L 0,${y1} z`
      }
      break
    case 'cube':
      {
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd', 'attrs', 'fmla'])
        const refr = RATIO_EMUs_Points
        let adj = 25000 * refr
        if (shapAdjst) {
          adj = parseInt(shapAdjst.substring(4)) * refr
        }
        const cnstVal2 = 100000 * refr
        const ss = Math.min(w, h)
        const a = (adj < 0) ? 0 : (adj > cnstVal2) ? cnstVal2 : adj
        const y1 = ss * a / cnstVal2
        const y4 = h - y1
        const x4 = w - y1
        pathData = `M 0,${y1} L ${y1},0 L ${w},0 L ${w},${y4} L ${x4},${h} L 0,${h} z M 0,${y1} L ${x4},${y1} M ${x4},${y1} L ${w},0 M ${x4},${y1} L ${x4},${h}`
      }
      break
    case 'bevel':
      {
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd', 'attrs', 'fmla'])
        const refr = RATIO_EMUs_Points
        let adj = 12500 * refr
        if (shapAdjst) {
          adj = parseInt(shapAdjst.substring(4)) * refr
        }
        const cnstVal1 = 50000 * refr
        const cnstVal2 = 100000 * refr
        const ss = Math.min(w, h)
        const a = (adj < 0) ? 0 : (adj > cnstVal1) ? cnstVal1 : adj
        const x1 = ss * a / cnstVal2
        const x2 = w - x1
        const y2 = h - x1
        pathData = `M 0,0 L ${w},0 L ${w},${h} L 0,${h} z M ${x1},${x1} L ${x2},${x1} L ${x2},${y2} L ${x1},${y2} z M 0,0 L ${x1},${x1} M 0,${h} L ${x1},${y2} M ${w},0 L ${x2},${x1} M ${w},${h} L ${x2},${y2}`
      }
      break
    case 'foldedCorner':
      {
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd', 'attrs', 'fmla'])
        const refr = RATIO_EMUs_Points
        let adj = 16667 * refr
        if (shapAdjst) {
          adj = parseInt(shapAdjst.substring(4)) * refr
        }
        const cnstVal1 = 50000 * refr
        const cnstVal2 = 100000 * refr
        const ss = Math.min(w, h)
        const a = (adj < 0) ? 0 : (adj > cnstVal1) ? cnstVal1 : adj
        const dy2 = ss * a / cnstVal2
        const dy1 = dy2 / 5
        const x1 = w - dy2
        const x2 = x1 + dy1
        const y2 = h - dy2
        const y1 = y2 + dy1
        pathData = `M ${x1},${h} L ${x2},${y1} L ${w},${y2} L ${x1},${h} L 0,${h} L 0,0 L ${w},0 L ${w},${y2}`
      }
      break
    case 'cloud':
    case 'cloudCallout':
      {
        const x0 = w * 3900 / 43200
        const y0 = h * 14370 / 43200
        const rX1 = w * 6753 / 43200,
          rY1 = h * 9190 / 43200,
          rX2 = w * 5333 / 43200,
          rY2 = h * 7267 / 43200,
          rX3 = w * 4365 / 43200,
          rY3 = h * 5945 / 43200,
          rX4 = w * 4857 / 43200,
          rY4 = h * 6595 / 43200,
          rY5 = h * 7273 / 43200,
          rX6 = w * 6775 / 43200,
          rY6 = h * 9220 / 43200,
          rX7 = w * 5785 / 43200,
          rY7 = h * 7867 / 43200,
          rX8 = w * 6752 / 43200,
          rY8 = h * 9215 / 43200,
          rX9 = w * 7720 / 43200,
          rY9 = h * 10543 / 43200,
          rX10 = w * 4360 / 43200,
          rY10 = h * 5918 / 43200,
          rX11 = w * 4345 / 43200
        const sA1 = -11429249 / 60000,
          wA1 = 7426832 / 60000,
          sA2 = -8646143 / 60000,
          wA2 = 5396714 / 60000,
          sA3 = -8748475 / 60000,
          wA3 = 5983381 / 60000,
          sA4 = -7859164 / 60000,
          wA4 = 7034504 / 60000,
          sA5 = -4722533 / 60000,
          wA5 = 6541615 / 60000,
          sA6 = -2776035 / 60000,
          wA6 = 7816140 / 60000,
          sA7 = 37501 / 60000,
          wA7 = 6842000 / 60000,
          sA8 = 1347096 / 60000,
          wA8 = 6910353 / 60000,
          sA9 = 3974558 / 60000,
          wA9 = 4542661 / 60000,
          sA10 = -16496525 / 60000,
          wA10 = 8804134 / 60000,
          sA11 = -14809710 / 60000,
          wA11 = 9151131 / 60000

        const getArc = (startX, startY, rX, rY, sA, wA) => {
          const cX = startX - rX * Math.cos(sA * Math.PI / 180)
          const cY = startY - rY * Math.sin(sA * Math.PI / 180)
          return shapeArc(cX, cY, rX, rY, sA, sA + wA, false).replace('M', 'L')
        }

        let cloudPath = `M ${x0},${y0}`
        let lastPoint = [x0, y0]
        const arcs = [
          [rX1, rY1, sA1, wA1],
          [rX2, rY2, sA2, wA2],
          [rX3, rY3, sA3, wA3],
          [rX4, rY4, sA4, wA4],
          [rX2, rY5, sA5, wA5],
          [rX6, rY6, sA6, wA6],
          [rX7, rY7, sA7, wA7],
          [rX8, rY8, sA8, wA8],
          [rX9, rY9, sA9, wA9],
          [rX10, rY10, sA10, wA10],
          [rX11, rY3, sA11, wA11]
        ]

        for (const arcParams of arcs) {
          const arcPath = getArc(lastPoint[0], lastPoint[1], ...arcParams)
          cloudPath += arcPath
          const lastL = arcPath.lastIndexOf('L')
          const coords = arcPath.substring(lastL + 1).split(' ')
          lastPoint = [parseFloat(coords[0]), parseFloat(coords[1])]
        }
        cloudPath += ' z'

        if (shapType === 'cloudCallout') {
          const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
          const refr = RATIO_EMUs_Points
          let adj1 = -20833 * refr
          let adj2 = 62500 * refr
          if (shapAdjst_ary) {
            for (const adj of shapAdjst_ary) {
              const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
              if (sAdj_name === 'adj1') {
                adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * refr
              } 
              else if (sAdj_name === 'adj2') {
                adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * refr
              }
            }
          }
          const cnstVal2 = 100000 * refr
          const ss = Math.min(w, h)
          const wd2 = w / 2,
            hd2 = h / 2
          const dxPos = w * adj1 / cnstVal2
          const dyPos = h * adj2 / cnstVal2
          const xPos = wd2 + dxPos
          const yPos = hd2 + dyPos
          const ht = hd2 * Math.cos(Math.atan(dyPos / dxPos))
          const wt = wd2 * Math.sin(Math.atan(dyPos / dxPos))
          const g2 = wd2 * Math.cos(Math.atan(wt / ht))
          const g3 = hd2 * Math.sin(Math.atan(wt / ht))
          const g4 = (adj1 >= 0) ? wd2 + g2 : wd2 - g2
          const g5 = (adj1 >= 0) ? hd2 + g3 : hd2 - g3
          const g6 = g4 - xPos
          const g7 = g5 - yPos
          const g8 = Math.sqrt(g6 * g6 + g7 * g7)
          const g9 = ss * 6600 / 21600
          const g10 = g8 - g9
          const g11 = g10 / 3
          const g12 = ss * 1800 / 21600
          const g13 = g11 + g12
          const g16 = (g13 * g6 / g8) + xPos
          const g17 = (g13 * g7 / g8) + yPos
          const g18 = ss * 4800 / 21600
          const g20 = g18 + (g11 * 2)
          const g23 = (g20 * g6 / g8) + xPos
          const g24 = (g20 * g7 / g8) + yPos
          const g25 = ss * 1200 / 21600
          const g26 = ss * 600 / 21600
          const x23 = xPos + g26
          const x24 = g16 + g25
          const x25 = g23 + g12
          const calloutPath = `${shapeArc(x23 - g26, yPos, g26, g26, 0, 360, true)} M ${x24},${g17} ${shapeArc(x24 - g25, g17, g25, g25, 0, 360, true).replace('M', 'L')} M ${x25},${g24} ${shapeArc(x25 - g12, g24, g12, g12, 0, 360, true).replace('M', 'L')}`
          cloudPath += calloutPath
        }
        pathData = cloudPath
      }
      break
    case 'smileyFace':
      {
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd', 'attrs', 'fmla'])
        const refr = RATIO_EMUs_Points
        let adj = 4653 * refr
        if (shapAdjst) {
          adj = parseInt(shapAdjst.substring(4)) * refr
        }
        const cnstVal1 = 50000 * refr
        const cnstVal2 = 100000 * refr
        const cnstVal3 = 4653 * refr
        const wd2 = w / 2,
          hd2 = h / 2
        const a = (adj < -cnstVal3) ? -cnstVal3 : (adj > cnstVal3) ? cnstVal3 : adj
        const x2 = w * 6215 / 21600
        const x3 = w * 13135 / 21600
        const x4 = w * 16640 / 21600
        const y1 = h * 7570 / 21600
        const y3 = h * 16515 / 21600
        const dy2 = h * a / cnstVal2
        const y2 = y3 - dy2
        const y4 = y3 + dy2
        const dy3 = h * a / cnstVal1
        const y5 = y4 + dy3
        const wR = w * 1125 / 21600
        const hR = h * 1125 / 21600
        const cX1 = x2
        const cY1 = y1
        const cX2 = x3
        const x1_mouth = w * 4969 / 21699
        pathData = `${shapeArc(cX1, cY1, wR, hR, 0, 360, true)} ${shapeArc(cX2, cY1, wR, hR, 0, 360, true)} M ${x1_mouth},${y2} Q ${wd2},${y5} ${x4},${y2} Q ${wd2},${y5} ${x1_mouth},${y2} M 0,${hd2} ${shapeArc(wd2, hd2, wd2, hd2, 180, 540, false).replace('M', 'L')} z`
      }
      break
    case 'verticalScroll':
    case 'horizontalScroll':
      {
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd', 'attrs', 'fmla'])
        const refr = RATIO_EMUs_Points
        let adj = 12500 * refr
        if (shapAdjst) {
          adj = parseInt(shapAdjst.substring(4)) * refr
        }
        const cnstVal1 = 25000 * refr
        const cnstVal2 = 100000 * refr
        const ss = Math.min(w, h)
        const t = 0,
          l = 0,
          b = h,
          r = w
        const a = (adj < 0) ? 0 : (adj > cnstVal1) ? cnstVal1 : adj
        const ch = ss * a / cnstVal2
        const ch2 = ch / 2
        const ch4 = ch / 4
        if (shapType === 'verticalScroll') {
          const x3 = ch + ch2
          const x4 = ch + ch
          const x6 = r - ch
          const x7 = r - ch2
          const x5 = x6 - ch2
          const y3 = b - ch
          const y4 = b - ch2
          pathData = `M ${ch},${y3} L ${ch},${ch2} ${shapeArc(x3, ch2, ch2, ch2, 180, 270, false).replace('M', 'L')} L ${x7},${t} ${shapeArc(x7, ch2, ch2, ch2, 270, 450, false).replace('M', 'L')} L ${x6},${ch} L ${x6},${y4} ${shapeArc(x5, y4, ch2, ch2, 0, 90, false).replace('M', 'L')} L ${ch2},${b} ${shapeArc(ch2, y4, ch2, ch2, 90, 270, false).replace('M', 'L')} z M ${x3},${t} ${shapeArc(x3, ch2, ch2, ch2, 270, 450, false).replace('M', 'L')} ${shapeArc(x3, x3 / 2, ch4, ch4, 90, 270, false).replace('M', 'L')} L ${x4},${ch2} M ${x6},${ch} L ${x3},${ch} M ${ch},${y4} ${shapeArc(ch2, y4, ch2, ch2, 0, 270, false).replace('M', 'L')} ${shapeArc(ch2, (y4 + y3) / 2, ch4, ch4, 270, 450, false).replace('M', 'L')} z M ${ch},${y4} L ${ch},${y3}`
        } 
        else if (shapType === 'horizontalScroll') {
          const y3 = ch + ch2
          const y4 = ch + ch
          const y6 = b - ch
          const y7 = b - ch2
          const y5 = y6 - ch2
          const x3 = r - ch
          const x4 = r - ch2
          pathData = `M ${l},${y3} ${shapeArc(ch2, y3, ch2, ch2, 180, 270, false).replace('M', 'L')} L ${x3},${ch} L ${x3},${ch2} ${shapeArc(x4, ch2, ch2, ch2, 180, 360, false).replace('M', 'L')} L ${r},${y5} ${shapeArc(x4, y5, ch2, ch2, 0, 90, false).replace('M', 'L')} L ${ch},${y6} L ${ch},${y7} ${shapeArc(ch2, y7, ch2, ch2, 0, 180, false).replace('M', 'L')} z M ${x4},${ch} ${shapeArc(x4, ch2, ch2, ch2, 90, -180, false).replace('M', 'L')} ${shapeArc((x3 + x4) / 2, ch2, ch4, ch4, 180, 0, false).replace('M', 'L')} z M ${x4},${ch} L ${x3},${ch} M ${ch2},${y4} L ${ch2},${y3} ${shapeArc(y3 / 2, y3, ch4, ch4, 180, 360, false).replace('M', 'L')} ${shapeArc(ch2, y3, ch2, ch2, 0, 180, false).replace('M', 'L')} M ${ch},${y3} L ${ch},${y6}`
        }
      }
      break
    case 'wedgeEllipseCallout':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        const refr = RATIO_EMUs_Points
        let adj1 = -20833 * refr
        let adj2 = 62500 * refr
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * refr
            } 
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * refr
            }
          }
        }
        const cnstVal1 = 100000 * RATIO_EMUs_Points
        const angVal1 = 11 * Math.PI / 180
        const vc = h / 2,
          hc = w / 2
        const dxPos = w * adj1 / cnstVal1
        const dyPos = h * adj2 / cnstVal1
        const xPos = hc + dxPos
        const yPos = vc + dyPos
        const pang = Math.atan2(dyPos * w, dxPos * h)
        const stAng = pang + angVal1
        const enAng = pang - angVal1
        const dx1 = hc * Math.cos(stAng)
        const dy1 = vc * Math.sin(stAng)
        const dx2 = hc * Math.cos(enAng)
        const dy2 = vc * Math.sin(enAng)
        const x1 = hc + dx1
        const y1 = vc + dy1
        const x2 = hc + dx2
        const y2 = vc + dy2
        pathData = `M ${x1},${y1} L ${xPos},${yPos} L ${x2},${y2} ${shapeArc(hc, vc, hc, vc, enAng * 180 / Math.PI, stAng * 180 / Math.PI, true).replace('M', 'L')}`
      }
      break
    case 'wedgeRectCallout':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        const refr = RATIO_EMUs_Points
        let adj1 = -20833 * refr
        let adj2 = 62500 * refr
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * refr
            } 
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * refr
            }
          }
        }
        const cnstVal1 = 100000 * RATIO_EMUs_Points
        const vc = h / 2,
          hc = w / 2
        const dxPos = w * adj1 / cnstVal1
        const dyPos = h * adj2 / cnstVal1
        const xPos = hc + dxPos
        const yPos = vc + dyPos
        const dq = dxPos * h / w
        const dz = Math.abs(dyPos) - Math.abs(dq)
        const xg1 = (dxPos > 0) ? 7 : 2
        const xg2 = (dxPos > 0) ? 10 : 5
        const x1 = w * xg1 / 12
        const x2 = w * xg2 / 12
        const yg1 = (dyPos > 0) ? 7 : 2
        const yg2 = (dyPos > 0) ? 10 : 5
        const y1 = h * yg1 / 12
        const y2 = h * yg2 / 12
        const xl = (dz > 0) ? 0 : ((dxPos > 0) ? 0 : xPos)
        const xt = (dz > 0) ? ((dyPos > 0) ? x1 : xPos) : x1
        const xr = (dz > 0) ? w : ((dxPos > 0) ? xPos : w)
        const xb = (dz > 0) ? ((dyPos > 0) ? xPos : x1) : x1
        const yl = (dz > 0) ? y1 : ((dxPos > 0) ? y1 : yPos)
        const yt = (dz > 0) ? ((dyPos > 0) ? 0 : yPos) : 0
        const yr = (dz > 0) ? y1 : ((dxPos > 0) ? yPos : y1)
        const yb = (dz > 0) ? ((dyPos > 0) ? yPos : h) : h
        pathData = `M 0,0 L ${x1},0 L ${xt},${yt} L ${x2},0 L ${w},0 L ${w},${y1} L ${xr},${yr} L ${w},${y2} L ${w},${h} L ${x2},${h} L ${xb},${yb} L ${x1},${h} L 0,${h} L 0,${y2} L ${xl},${yl} L 0,${y1} z`
      }
      break
    case 'wedgeRoundRectCallout':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        const refr = RATIO_EMUs_Points
        let adj1 = -20833 * refr
        let adj2 = 62500 * refr
        let adj3 = 16667 * refr
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * refr
            } 
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * refr
            } 
            else if (sAdj_name === 'adj3') {
              adj3 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * refr
            }
          }
        }
        const cnstVal1 = 100000 * RATIO_EMUs_Points
        const ss = Math.min(w, h)
        const vc = h / 2,
          hc = w / 2
        const dxPos = w * adj1 / cnstVal1
        const dyPos = h * adj2 / cnstVal1
        const xPos = hc + dxPos
        const yPos = vc + dyPos
        const dq = dxPos * h / w
        const dz = Math.abs(dyPos) - Math.abs(dq)
        const xg1 = (dxPos > 0) ? 7 : 2
        const xg2 = (dxPos > 0) ? 10 : 5
        const x1 = w * xg1 / 12
        const x2 = w * xg2 / 12
        const yg1 = (dyPos > 0) ? 7 : 2
        const yg2 = (dyPos > 0) ? 10 : 5
        const y1 = h * yg1 / 12
        const y2 = h * yg2 / 12
        const xl = (dz > 0) ? 0 : ((dxPos > 0) ? 0 : xPos)
        const xt = (dz > 0) ? ((dyPos > 0) ? x1 : xPos) : x1
        const xr = (dz > 0) ? w : ((dxPos > 0) ? xPos : w)
        const xb = (dz > 0) ? ((dyPos > 0) ? xPos : x1) : x1
        const yl = (dz > 0) ? y1 : ((dxPos > 0) ? y1 : yPos)
        const yt = (dz > 0) ? ((dyPos > 0) ? 0 : yPos) : 0
        const yr = (dz > 0) ? y1 : ((dxPos > 0) ? yPos : y1)
        const yb = (dz > 0) ? ((dyPos > 0) ? yPos : h) : h
        const u1 = ss * adj3 / cnstVal1
        const u2 = w - u1
        const v2 = h - u1
        pathData = `M 0,${u1} ${shapeArc(u1, u1, u1, u1, 180, 270, false).replace('M', 'L')} L ${x1},0 L ${xt},${yt} L ${x2},0 L ${u2},0 ${shapeArc(u2, u1, u1, u1, 270, 360, false).replace('M', 'L')} L ${w},${y1} L ${xr},${yr} L ${w},${y2} L ${w},${v2} ${shapeArc(u2, v2, u1, u1, 0, 90, false).replace('M', 'L')} L ${x2},${h} L ${xb},${yb} L ${x1},${h} L ${u1},${h} ${shapeArc(u1, v2, u1, u1, 90, 180, false).replace('M', 'L')} L 0,${y2} L ${xl},${yl} L 0,${y1} z`
      }
      break
    case 'accentBorderCallout1':
    case 'accentBorderCallout2':
    case 'accentBorderCallout3':
    case 'borderCallout1':
    case 'borderCallout2':
    case 'borderCallout3':
    case 'accentCallout1':
    case 'accentCallout2':
    case 'accentCallout3':
    case 'callout1':
    case 'callout2':
    case 'callout3':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        const refr = RATIO_EMUs_Points
        let adj1 = 18750 * refr
        let adj2 = -8333 * refr
        let adj3 = 18750 * refr
        let adj4 = -16667 * refr
        let adj5 = 100000 * refr
        let adj6 = -16667 * refr
        let adj7 = 112963 * refr
        let adj8 = -8333 * refr
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * refr
            }
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * refr
            }
            else if (sAdj_name === 'adj3') {
              adj3 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * refr
            }
            else if (sAdj_name === 'adj4') {
              adj4 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * refr
            }
            else if (sAdj_name === 'adj5') {
              adj5 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * refr
            }
            else if (sAdj_name === 'adj6') {
              adj6 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * refr
            }
            else if (sAdj_name === 'adj7') {
              adj7 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * refr
            }
            else if (sAdj_name === 'adj8') {
              adj8 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * refr
            }
          }
        }
        const cnstVal1 = 100000 * refr
        let x1, y1, x2, y2, x3, y3, x4, y4
        const baseRect = `M 0,0 L ${w},0 L ${w},${h} L 0,${h} z`
        switch (shapType) {
          case 'borderCallout1':
          case 'callout1':
            if (!shapAdjst_ary) {
              adj1 = 18750 * refr
              adj2 = -8333 * refr
              adj3 = 112500 * refr
              adj4 = -38333 * refr
            }
            y1 = h * adj1 / cnstVal1
            x1 = w * adj2 / cnstVal1
            y2 = h * adj3 / cnstVal1
            x2 = w * adj4 / cnstVal1
            pathData = `${baseRect} M ${x1},${y1} L ${x2},${y2}`
            break
          case 'borderCallout2':
          case 'callout2':
            if (!shapAdjst_ary) {
              adj1 = 18750 * refr
              adj2 = -8333 * refr
              adj3 = 18750 * refr
              adj4 = -16667 * refr
              adj5 = 112500 * refr
              adj6 = -46667 * refr
            }
            y1 = h * adj1 / cnstVal1
            x1 = w * adj2 / cnstVal1
            y2 = h * adj3 / cnstVal1
            x2 = w * adj4 / cnstVal1
            y3 = h * adj5 / cnstVal1
            x3 = w * adj6 / cnstVal1
            pathData = `${baseRect} M ${x1},${y1} L ${x2},${y2} L ${x3},${y3}`
            break
          case 'borderCallout3':
          case 'callout3':
            if (!shapAdjst_ary) {
              adj1 = 18750 * refr
              adj2 = -8333 * refr
              adj3 = 18750 * refr
              adj4 = -16667 * refr
              adj5 = 100000 * refr
              adj6 = -16667 * refr
              adj7 = 112963 * refr
              adj8 = -8333 * refr
            }
            y1 = h * adj1 / cnstVal1
            x1 = w * adj2 / cnstVal1
            y2 = h * adj3 / cnstVal1
            x2 = w * adj4 / cnstVal1
            y3 = h * adj5 / cnstVal1
            x3 = w * adj6 / cnstVal1
            y4 = h * adj7 / cnstVal1
            x4 = w * adj8 / cnstVal1
            pathData = `${baseRect} M ${x1},${y1} L ${x2},${y2} L ${x3},${y3} L ${x4},${y4}`
            break
          case 'accentBorderCallout1':
          case 'accentCallout1':
            if (!shapAdjst_ary) {
              adj1 = 18750 * refr
              adj2 = -8333 * refr
              adj3 = 112500 * refr
              adj4 = -38333 * refr
            }
            y1 = h * adj1 / cnstVal1
            x1 = w * adj2 / cnstVal1
            y2 = h * adj3 / cnstVal1
            x2 = w * adj4 / cnstVal1
            pathData = `${baseRect} M ${x1},${y1} L ${x2},${y2} M ${x1},0 L ${x1},${h}`
            break
          case 'accentBorderCallout2':
          case 'accentCallout2':
            if (!shapAdjst_ary) {
              adj1 = 18750 * refr
              adj2 = -8333 * refr
              adj3 = 18750 * refr
              adj4 = -16667 * refr
              adj5 = 112500 * refr
              adj6 = -46667 * refr
            }
            y1 = h * adj1 / cnstVal1
            x1 = w * adj2 / cnstVal1
            y2 = h * adj3 / cnstVal1
            x2 = w * adj4 / cnstVal1
            y3 = h * adj5 / cnstVal1
            x3 = w * adj6 / cnstVal1
            pathData = `${baseRect} M ${x1},${y1} L ${x2},${y2} L ${x3},${y3} M ${x1},0 L ${x1},${h}`
            break
          case 'accentBorderCallout3':
          case 'accentCallout3':
            if (!shapAdjst_ary) {
              adj1 = 18750 * refr
              adj2 = -8333 * refr
              adj3 = 18750 * refr
              adj4 = -16667 * refr
              adj5 = 100000 * refr
              adj6 = -16667 * refr
              adj7 = 112963 * refr
              adj8 = -8333 * refr
            }
            y1 = h * adj1 / cnstVal1
            x1 = w * adj2 / cnstVal1
            y2 = h * adj3 / cnstVal1
            x2 = w * adj4 / cnstVal1
            y3 = h * adj5 / cnstVal1
            x3 = w * adj6 / cnstVal1
            y4 = h * adj7 / cnstVal1
            x4 = w * adj8 / cnstVal1
            pathData = `${baseRect} M ${x1},${y1} L ${x2},${y2} L ${x3},${y3} L ${x4},${y4} M ${x1},0 L ${x1},${h}`
            break
          default:
        }
      }
      break
    case 'leftRightRibbon':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        const refr = RATIO_EMUs_Points
        let adj1 = 50000 * refr
        let adj2 = 50000 * refr
        let adj3 = 16667 * refr
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * refr
            } 
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * refr
            } 
            else if (sAdj_name === 'adj3') {
              adj3 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * refr
            }
          }
        }
        const cnstVal1 = 33333 * refr
        const cnstVal2 = 100000 * refr
        const cnstVal3 = 200000 * refr
        const cnstVal4 = 400000 * refr
        const ss = Math.min(w, h)
        const hc = w / 2,
          vc = h / 2
        const a3 = (adj3 < 0) ? 0 : (adj3 > cnstVal1) ? cnstVal1 : adj3
        const maxAdj1 = cnstVal2 - a3
        const a1 = (adj1 < 0) ? 0 : (adj1 > maxAdj1) ? maxAdj1 : adj1
        const w1 = hc - (w / 32)
        const maxAdj2 = cnstVal2 * w1 / ss
        const a2 = (adj2 < 0) ? 0 : (adj2 > maxAdj2) ? maxAdj2 : adj2
        const x1 = ss * a2 / cnstVal2
        const x4 = w - x1
        const dy1 = h * a1 / cnstVal3
        const dy2 = h * a3 / -cnstVal3
        const ly1 = vc + dy2 - dy1
        const ry4 = vc + dy1 - dy2
        const ly2 = ly1 + dy1
        const ry3 = h - ly2
        const ly4 = ly2 * 2
        const ry2 = h - (ly4 - ly1)
        const hR = a3 * ss / cnstVal4
        const x2 = hc - (w / 32)
        const x3 = hc + (w / 32)
        const y1 = ly1 + hR
        const y2_arc = ry2 - hR
        pathData = `M 0,${ly2} L ${x1},0 L ${x1},${ly1} L ${hc},${ly1} ${shapeArc(hc, y1, w / 32, hR, 270, 450, false).replace('M', 'L')} ${shapeArc(hc, y2_arc, w / 32, hR, 270, 90, false).replace('M', 'L')} L ${x4},${ry2} L ${x4},${h - ly4} L ${w},${ry3} L ${x4},${h} L ${x4},${ry4} L ${hc},${ry4} ${shapeArc(hc, ry4 - hR, w / 32, hR, 90, 180, false).replace('M', 'L')} L ${x2},${ly4 - ly1} L ${x1},${ly4 - ly1} L ${x1},${ly4} z M ${x3},${y1} L ${x3},${ry2} M ${x2},${y2_arc} L ${x2},${ly4 - ly1}`
      }
      break
    case 'ribbon':
    case 'ribbon2':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let adj1 = 16667 * RATIO_EMUs_Points
        let adj2 = 50000 * RATIO_EMUs_Points
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            } 
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
          }
        }
        const cnstVal1 = 25000 * RATIO_EMUs_Points
        const cnstVal2 = 33333 * RATIO_EMUs_Points
        const cnstVal3 = 75000 * RATIO_EMUs_Points
        const cnstVal4 = 100000 * RATIO_EMUs_Points
        const cnstVal5 = 200000 * RATIO_EMUs_Points
        const cnstVal6 = 400000 * RATIO_EMUs_Points
        const hc = w / 2,
          t = 0,
          l = 0,
          b = h,
          r = w,
          wd8 = w / 8,
          wd32 = w / 32
        const a1 = (adj1 < 0) ? 0 : (adj1 > cnstVal2) ? cnstVal2 : adj1
        const a2 = (adj2 < cnstVal1) ? cnstVal1 : (adj2 > cnstVal3) ? cnstVal3 : adj2
        const x10 = r - wd8
        const dx2 = w * a2 / cnstVal5
        const x2 = hc - dx2
        const x9 = hc + dx2
        const x3 = x2 + wd32
        const x8 = x9 - wd32
        const x5 = x2 + wd8
        const x6 = x9 - wd8
        const x4 = x5 - wd32
        const x7 = x6 + wd32
        const hR = h * a1 / cnstVal6
        if (shapType === 'ribbon2') {
          const dy1 = h * a1 / cnstVal5
          const y1 = b - dy1
          const dy2 = h * a1 / cnstVal4
          const y2 = b - dy2
          const y4 = t + dy2
          const y3 = (y4 + b) / 2
          const y6 = b - hR
          const y7 = y1 - hR
          pathData = `M ${l},${b} L ${wd8},${y3} L ${l},${y4} L ${x2},${y4} L ${x2},${hR} ${shapeArc(x3, hR, wd32, hR, 180, 270, false).replace('M', 'L')} L ${x8},${t} ${shapeArc(x8, hR, wd32, hR, 270, 360, false).replace('M', 'L')} L ${x9},${y4} L ${r},${y4} L ${x10},${y3} L ${r},${b} L ${x7},${b} ${shapeArc(x7, y6, wd32, hR, 90, 270, false).replace('M', 'L')} L ${x8},${y1} ${shapeArc(x8, y7, wd32, hR, 90, -90, false).replace('M', 'L')} L ${x3},${y2} ${shapeArc(x3, y7, wd32, hR, 270, 90, false).replace('M', 'L')} L ${x4},${y1} ${shapeArc(x4, y6, wd32, hR, 270, 450, false).replace('M', 'L')} z M ${x5},${y2} L ${x5},${y6} M ${x6},${y6} L ${x6},${y2} M ${x2},${y7} L ${x2},${y4} M ${x9},${y4} L ${x9},${y7}`
        } 
        else if (shapType === 'ribbon') {
          const y1 = h * a1 / cnstVal5
          const y2 = h * a1 / cnstVal4
          const y4 = b - y2
          const y3 = y4 / 2
          const y5 = b - hR
          const y6 = y2 - hR
          pathData = `M ${l},${t} L ${x4},${t} ${shapeArc(x4, hR, wd32, hR, 270, 450, false).replace('M', 'L')} L ${x3},${y1} ${shapeArc(x3, y6, wd32, hR, 270, 90, false).replace('M', 'L')} L ${x8},${y2} ${shapeArc(x8, y6, wd32, hR, 90, -90, false).replace('M', 'L')} L ${x7},${y1} ${shapeArc(x7, hR, wd32, hR, 90, 270, false).replace('M', 'L')} L ${r},${t} L ${x10},${y3} L ${r},${y4} L ${x9},${y4} L ${x9},${y5} ${shapeArc(x8, y5, wd32, hR, 0, 90, false).replace('M', 'L')} L ${x3},${b} ${shapeArc(x3, y5, wd32, hR, 90, 180, false).replace('M', 'L')} L ${x2},${y4} L ${l},${y4} L ${wd8},${y3} z M ${x5},${hR} L ${x5},${y2} M ${x6},${y2} L ${x6},${hR} M ${x2},${y4} L ${x2},${y6} M ${x9},${y6} L ${x9},${y4}`
        }
      }
      break
    case 'doubleWave':
    case 'wave':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let adj1 = (shapType === 'doubleWave') ? 6250 * RATIO_EMUs_Points : 12500 * RATIO_EMUs_Points
        let adj2 = 0
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            } 
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
          }
        }
        const cnstVal2 = -10000 * RATIO_EMUs_Points
        const cnstVal3 = 50000 * RATIO_EMUs_Points
        const cnstVal4 = 100000 * RATIO_EMUs_Points
        const l = 0,
          b = h,
          r = w
        if (shapType === 'doubleWave') {
          const cnstVal1 = 12500 * RATIO_EMUs_Points
          const a1 = (adj1 < 0) ? 0 : (adj1 > cnstVal1) ? cnstVal1 : adj1
          const a2 = (adj2 < cnstVal2) ? cnstVal2 : (adj2 > cnstVal4) ? cnstVal4 : adj2
          const y1 = h * a1 / cnstVal4
          const dy2 = y1 * 10 / 3
          const y2 = y1 - dy2
          const y3 = y1 + dy2
          const y4 = b - y1
          const y5 = y4 - dy2
          const y6 = y4 + dy2
          const of2 = w * a2 / cnstVal3
          const dx2 = (of2 > 0) ? 0 : of2
          const x2 = l - dx2
          const dx8 = (of2 > 0) ? of2 : 0
          const x8 = r - dx8
          const dx3 = (dx2 + x8) / 6
          const x3 = x2 + dx3
          const dx4 = (dx2 + x8) / 3
          const x4 = x2 + dx4
          const x5 = (x2 + x8) / 2
          const x6 = x5 + dx3
          const x7 = (x6 + x8) / 2
          const x9 = l + dx8
          const x15 = r + dx2
          const x10 = x9 + dx3
          const x11 = x9 + dx4
          const x12 = (x9 + x15) / 2
          const x13 = x12 + dx3
          const x14 = (x13 + x15) / 2
          pathData = `M ${x2},${y1} C ${x3},${y2} ${x4},${y3} ${x5},${y1} C ${x6},${y2} ${x7},${y3} ${x8},${y1} L ${x15},${y4} C ${x14},${y6} ${x13},${y5} ${x12},${y4} C ${x11},${y6} ${x10},${y5} ${x9},${y4} z`
        } 
        else if (shapType === 'wave') {
          const cnstVal5 = 20000 * RATIO_EMUs_Points
          const a1 = (adj1 < 0) ? 0 : (adj1 > cnstVal5) ? cnstVal5 : adj1
          const a2 = (adj2 < cnstVal2) ? cnstVal2 : (adj2 > cnstVal4) ? cnstVal4 : adj2
          const y1 = h * a1 / cnstVal4
          const dy2 = y1 * 10 / 3
          const y2 = y1 - dy2
          const y3 = y1 + dy2
          const y4 = b - y1
          const y5 = y4 - dy2
          const y6 = y4 + dy2
          const of2 = w * a2 / cnstVal3
          const dx2 = (of2 > 0) ? 0 : of2
          const x2 = l - dx2
          const dx5 = (of2 > 0) ? of2 : 0
          const x5 = r - dx5
          const dx3 = (dx2 + x5) / 3
          const x3 = x2 + dx3
          const x4 = (x3 + x5) / 2
          const x6 = l + dx5
          const x10 = r + dx2
          const x7 = x6 + dx3
          const x8 = (x7 + x10) / 2
          pathData = `M ${x2},${y1} C ${x3},${y2} ${x4},${y3} ${x5},${y1} L ${x10},${y4} C ${x8},${y6} ${x7},${y5} ${x6},${y4} z`
        }
      }
      break
    case 'ellipseRibbon':
    case 'ellipseRibbon2':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let adj1 = 25000 * RATIO_EMUs_Points
        let adj2 = 50000 * RATIO_EMUs_Points
        let adj3 = 12500 * RATIO_EMUs_Points
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            } 
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            } 
            else if (sAdj_name === 'adj3') {
              adj3 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
          }
        }
        const cnstVal1 = 25000 * RATIO_EMUs_Points
        const cnstVal3 = 75000 * RATIO_EMUs_Points
        const cnstVal4 = 100000 * RATIO_EMUs_Points
        const cnstVal5 = 200000 * RATIO_EMUs_Points
        const hc = w / 2,
          t = 0,
          l = 0,
          b = h,
          r = w,
          wd8 = w / 8
        const a1 = (adj1 < 0) ? 0 : (adj1 > cnstVal4) ? cnstVal4 : adj1
        const a2 = (adj2 < cnstVal1) ? cnstVal1 : (adj2 > cnstVal3) ? cnstVal3 : adj2
        const q10 = cnstVal4 - a1
        const minAdj3 = (a1 - (q10 / 2) > 0) ? a1 - (q10 / 2) : 0
        const a3 = (adj3 < minAdj3) ? minAdj3 : (adj3 > a1) ? a1 : adj3
        const dx2 = w * a2 / cnstVal5
        const x2 = hc - dx2
        const x3 = x2 + wd8
        const x4 = r - x3
        const x5 = r - x2
        const x6 = r - wd8
        const dy1 = h * a3 / cnstVal4
        const f1 = 4 * dy1 / w
        const q2 = x3 - (x3 * x3 / w)
        const cx1 = x3 / 2
        const cx2 = r - cx1
        const q1_h = h * a1 / cnstVal4
        const dy3 = q1_h - dy1
        const q4 = x2 - (x2 * x2 / w)
        const q5 = f1 * q4
        const rh = b - q1_h
        const q8 = dy1 * 14 / 16
        const cx4 = x2 / 2
        const q9 = f1 * cx4
        const cx5 = r - cx4
        if (shapType === 'ellipseRibbon') {
          const y1 = f1 * q2
          const cy1 = f1 * cx1
          const y3 = q5 + dy3
          const q6 = dy1 + dy3 - y3
          const cy3 = (q6 + dy1) + dy3
          const y2 = (q8 + rh) / 2
          const y5 = q5 + rh
          const y6 = y3 + rh
          const cy4 = q9 + rh
          const cy6 = cy3 + rh
          const y7 = y1 + dy3
          pathData = `M ${l},${t} Q ${cx1},${cy1} ${x3},${y1} L ${x2},${y3} Q ${hc},${cy3} ${x5},${y3} L ${x4},${y1} Q ${cx2},${cy1} ${r},${t} L ${x6},${y2} L ${r},${rh} Q ${cx5},${cy4} ${x5},${y5} L ${x5},${y6} Q ${hc},${cy6} ${x2},${y6} L ${x2},${y5} Q ${cx4},${cy4} ${l},${rh} L ${wd8},${y2} z M ${x2},${y5} L ${x2},${y3} M ${x5},${y3} L ${x5},${y5} M ${x3},${y1} L ${x3},${y7} M ${x4},${y7} L ${x4},${y1}`
        } 
        else if (shapType === 'ellipseRibbon2') {
          const u1 = f1 * q2
          const y1 = b - u1
          const cu1 = f1 * cx1
          const cy1 = b - cu1
          const u3 = q5 + dy3
          const y3 = b - u3
          const q6 = dy1 + dy3 - u3
          const cu3 = (q6 + dy1) + dy3
          const cy3 = b - cu3
          const u2 = (q8 + rh) / 2
          const y2 = b - u2
          const u5 = q5 + rh
          const y5 = b - u5
          const u6 = u3 + rh
          const y6 = b - u6
          const cu4 = q9 + rh
          const cy4 = b - cu4
          const cu6 = cu3 + rh
          const cy6 = b - cu6
          const u7 = u1 + dy3
          const y7 = b - u7
          pathData = `M ${l},${b} L ${wd8},${y2} L ${l},${q1_h} Q ${cx4},${cy4} ${x2},${y5} L ${x2},${y6} Q ${hc},${cy6} ${x5},${y6} L ${x5},${y5} Q ${cx5},${cy4} ${r},${q1_h} L ${x6},${y2} L ${r},${b} Q ${cx2},${cy1} ${x4},${y1} L ${x5},${y3} Q ${hc},${cy3} ${x2},${y3} L ${x3},${y1} Q ${cx1},${cy1} ${l},${b} z M ${x2},${y3} L ${x2},${y5} M ${x5},${y5} L ${x5},${y3} M ${x3},${y7} L ${x3},${y1} M ${x4},${y1} L ${x4},${y7}`
        }
      }
      break
    case 'line':
    case 'straightConnector1':
    case 'bentConnector4':
    case 'bentConnector5':
    case 'curvedConnector2':
    case 'curvedConnector3':
    case 'curvedConnector4':
    case 'curvedConnector5':
      pathData = `M 0 0 L ${w} ${h}`
      break
    case 'rightArrow':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let sAdj1_val = 0.25
        let sAdj2_val = 0.5
        if (shapAdjst_ary) {
          const max_sAdj2_const = w / h
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              sAdj1_val = 0.5 - (parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) / 200000)
            } 
            else if (sAdj_name === 'adj2') {
              const sAdj2_val2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) / 100000
              sAdj2_val = 1 - (sAdj2_val2 / max_sAdj2_const)
            }
          }
        }
        pathData = `M ${w} ${h / 2} L ${sAdj2_val * w} 0 L ${sAdj2_val * w} ${sAdj1_val * h} L 0 ${sAdj1_val * h} L 0 ${(1 - sAdj1_val) * h} L ${sAdj2_val * w} ${(1 - sAdj1_val) * h} L ${sAdj2_val * w} ${h} Z`
      }
      break
    case 'leftArrow':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let sAdj1_val = 0.25
        let sAdj2_val = 0.5
        if (shapAdjst_ary) {
          const max_sAdj2_const = w / h
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              sAdj1_val = 0.5 - (parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) / 200000)
            } 
            else if (sAdj_name === 'adj2') {
              const sAdj2_val2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) / 100000
              sAdj2_val = sAdj2_val2 / max_sAdj2_const
            }
          }
        }
        pathData = `M 0 ${h / 2} L ${sAdj2_val * w} ${h} L ${sAdj2_val * w} ${(1 - sAdj1_val) * h} L ${w} ${(1 - sAdj1_val) * h} L ${w} ${sAdj1_val * h} L ${sAdj2_val * w} ${sAdj1_val * h} L ${sAdj2_val * w} 0 Z`
      }
      break
    case 'downArrow':
    case 'flowChartOffpageConnector':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let sAdj1_val = 0.25
        let sAdj2_val = 0.5
        if (shapAdjst_ary) {
          const max_sAdj2_const = h / w
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              sAdj1_val = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) / 200000
            } 
            else if (sAdj_name === 'adj2') {
              const sAdj2_val2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) / 100000
              sAdj2_val = sAdj2_val2 / max_sAdj2_const
            }
          }
        }
        if (shapType === 'flowChartOffpageConnector') {
          sAdj1_val = 0.5
          sAdj2_val = 0.212
        }
        pathData = `M ${(0.5 - sAdj1_val) * w} 0 L ${(0.5 - sAdj1_val) * w} ${(1 - sAdj2_val) * h} L 0 ${(1 - sAdj2_val) * h} L ${w / 2} ${h} L ${w} ${(1 - sAdj2_val) * h} L ${(0.5 + sAdj1_val) * w} ${(1 - sAdj2_val) * h} L ${(0.5 + sAdj1_val) * w} 0 Z`
      }
      break
    case 'upArrow':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let sAdj1_val = 0.25
        let sAdj2_val = 0.5
        if (shapAdjst_ary) {
          const max_sAdj2_const = h / w
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              sAdj1_val = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) / 200000
            } 
            else if (sAdj_name === 'adj2') {
              const sAdj2_val2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) / 100000
              sAdj2_val = sAdj2_val2 / max_sAdj2_const
            }
          }
        }
        pathData = `M ${w / 2} 0 L 0 ${sAdj2_val * h} L ${(0.5 - sAdj1_val) * w} ${sAdj2_val * h} L ${(0.5 - sAdj1_val) * w} ${h} L ${(0.5 + sAdj1_val) * w} ${h} L ${(0.5 + sAdj1_val) * w} ${sAdj2_val * h} L ${w} ${sAdj2_val * h} Z`
      }
      break
    case 'leftRightArrow':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let sAdj1_val = 0.25
        let sAdj2_val = 0.25
        if (shapAdjst_ary) {
          const max_sAdj2_const = w / h
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              sAdj1_val = 0.5 - (parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) / 200000)
            } 
            else if (sAdj_name === 'adj2') {
              const sAdj2_val2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) / 100000
              sAdj2_val = sAdj2_val2 / max_sAdj2_const
            }
          }
        }
        pathData = `M 0 ${h / 2} L ${sAdj2_val * w} ${h} L ${sAdj2_val * w} ${(1 - sAdj1_val) * h} L ${(1 - sAdj2_val) * w} ${(1 - sAdj1_val) * h} L ${(1 - sAdj2_val) * w} ${h} L ${w} ${h / 2} L ${(1 - sAdj2_val) * w} 0 L ${(1 - sAdj2_val) * w} ${sAdj1_val * h} L ${sAdj2_val * w} ${sAdj1_val * h} L ${sAdj2_val * w} 0 Z`
      }
      break
    case 'upDownArrow':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let sAdj1_val = 0.25
        let sAdj2_val = 0.25
        if (shapAdjst_ary) {
          const max_sAdj2_const = h / w
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              sAdj1_val = 0.5 - (parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) / 200000)
            } 
            else if (sAdj_name === 'adj2') {
              const sAdj2_val2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) / 100000
              sAdj2_val = sAdj2_val2 / max_sAdj2_const
            }
          }
        }
        pathData = `M ${w / 2} 0 L 0 ${sAdj2_val * h} L ${sAdj1_val * w} ${sAdj2_val * h} L ${sAdj1_val * w} ${(1 - sAdj2_val) * h} L 0 ${(1 - sAdj2_val) * h} L ${w / 2} ${h} L ${w} ${(1 - sAdj2_val) * h} L ${(1 - sAdj1_val) * w} ${(1 - sAdj2_val) * h} L ${(1 - sAdj1_val) * w} ${sAdj2_val * h} L ${w} ${sAdj2_val * h} Z`
      }
      break
    case 'quadArrow':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let adj1 = 22500 * RATIO_EMUs_Points
        let adj2 = 22500 * RATIO_EMUs_Points
        let adj3 = 22500 * RATIO_EMUs_Points
        const cnstVal1 = 50000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        const cnstVal3 = 200000 * RATIO_EMUs_Points
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            } 
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            } 
            else if (sAdj_name === 'adj3') {
              adj3 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
          }
        }
        const vc = h / 2,
          hc = w / 2
        const minWH = Math.min(w, h)
        const a2 = (adj2 < 0) ? 0 : (adj2 > cnstVal1) ? cnstVal1 : adj2
        const maxAdj1 = 2 * a2
        const a1 = (adj1 < 0) ? 0 : (adj1 > maxAdj1) ? maxAdj1 : adj1
        const q1 = cnstVal2 - maxAdj1
        const maxAdj3 = q1 / 2
        const a3 = (adj3 < 0) ? 0 : (adj3 > maxAdj3) ? maxAdj3 : adj3
        const x1 = minWH * a3 / cnstVal2
        const dx2 = minWH * a2 / cnstVal2
        const x2 = hc - dx2
        const x5 = hc + dx2
        const dx3 = minWH * a1 / cnstVal3
        const x3 = hc - dx3
        const x4 = hc + dx3
        const x6 = w - x1
        const y2 = vc - dx2
        const y5 = vc + dx2
        const y3 = vc - dx3
        const y4 = vc + dx3
        const y6 = h - x1
        pathData = `M 0,${vc} L ${x1},${y2} L ${x1},${y3} L ${x3},${y3} L ${x3},${x1} L ${x2},${x1} L ${hc},0 L ${x5},${x1} L ${x4},${x1} L ${x4},${y3} L ${x6},${y3} L ${x6},${y2} L ${w},${vc} L ${x6},${y5} L ${x6},${y4} L ${x4},${y4} L ${x4},${y6} L ${x5},${y6} L ${hc},${h} L ${x2},${y6} L ${x3},${y6} L ${x3},${y4} L ${x1},${y4} L ${x1},${y5} z`
      }
      break
    case 'leftRightUpArrow':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let adj1 = 25000 * RATIO_EMUs_Points
        let adj2 = 25000 * RATIO_EMUs_Points
        let adj3 = 25000 * RATIO_EMUs_Points
        const cnstVal1 = 50000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        const cnstVal3 = 200000 * RATIO_EMUs_Points
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            } 
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            } 
            else if (sAdj_name === 'adj3') {
              adj3 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
          }
        }
        const hc = w / 2
        const minWH = Math.min(w, h)
        const a2 = (adj2 < 0) ? 0 : (adj2 > cnstVal1) ? cnstVal1 : adj2
        const maxAdj1 = 2 * a2
        const a1 = (adj1 < 0) ? 0 : (adj1 > maxAdj1) ? maxAdj1 : adj1
        const q1 = cnstVal2 - maxAdj1
        const maxAdj3 = q1 / 2
        const a3 = (adj3 < 0) ? 0 : (adj3 > maxAdj3) ? maxAdj3 : adj3
        const x1 = minWH * a3 / cnstVal2
        const dx2 = minWH * a2 / cnstVal2
        const x2 = hc - dx2
        const x5 = hc + dx2
        const dx3 = minWH * a1 / cnstVal3
        const x3 = hc - dx3
        const x4 = hc + dx3
        const x6 = w - x1
        const dy2 = minWH * a2 / cnstVal1
        const y2 = h - dy2
        const y4 = h - dx2
        const y3 = y4 - dx3
        const y5 = y4 + dx3
        pathData = `M 0,${y4} L ${x1},${y2} L ${x1},${y3} L ${x3},${y3} L ${x3},${x1} L ${x2},${x1} L ${hc},0 L ${x5},${x1} L ${x4},${x1} L ${x4},${y3} L ${x6},${y3} L ${x6},${y2} L ${w},${y4} L ${x6},${h} L ${x6},${y5} L ${x1},${y5} L ${x1},${h} z`
      }
      break
    case 'leftUpArrow':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let adj1 = 25000 * RATIO_EMUs_Points
        let adj2 = 25000 * RATIO_EMUs_Points
        let adj3 = 25000 * RATIO_EMUs_Points
        const cnstVal1 = 50000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        const cnstVal3 = 200000 * RATIO_EMUs_Points
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            } 
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            } 
            else if (sAdj_name === 'adj3') {
              adj3 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
          }
        }
        const minWH = Math.min(w, h)
        const a2 = (adj2 < 0) ? 0 : (adj2 > cnstVal1) ? cnstVal1 : adj2
        const maxAdj1 = 2 * a2
        const a1 = (adj1 < 0) ? 0 : (adj1 > maxAdj1) ? maxAdj1 : adj1
        const maxAdj3 = cnstVal2 - maxAdj1
        const a3 = (adj3 < 0) ? 0 : (adj3 > maxAdj3) ? maxAdj3 : adj3
        const x1 = minWH * a3 / cnstVal2
        const dx2 = minWH * a2 / cnstVal1
        const x2 = w - dx2
        const y2 = h - dx2
        const dx4 = minWH * a2 / cnstVal2
        const x4 = w - dx4
        const y4 = h - dx4
        const dx3 = minWH * a1 / cnstVal3
        const x3 = x4 - dx3
        const x5 = x4 + dx3
        const y3 = y4 - dx3
        const y5 = y4 + dx3
        pathData = `M 0,${y4} L ${x1},${y2} L ${x1},${y3} L ${x3},${y3} L ${x3},${x1} L ${x2},${x1} L ${x4},0 L ${w},${x1} L ${x5},${x1} L ${x5},${y5} L ${x1},${y5} L ${x1},${h} z`
      }
      break
    case 'bentUpArrow':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let adj1 = 25000 * RATIO_EMUs_Points
        let adj2 = 25000 * RATIO_EMUs_Points
        let adj3 = 25000 * RATIO_EMUs_Points
        const cnstVal1 = 50000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        const cnstVal3 = 200000 * RATIO_EMUs_Points
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            } 
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            } 
            else if (sAdj_name === 'adj3') {
              adj3 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
          }
        }
        const minWH = Math.min(w, h)
        const a1 = (adj1 < 0) ? 0 : (adj1 > cnstVal1) ? cnstVal1 : adj1
        const a2 = (adj2 < 0) ? 0 : (adj2 > cnstVal1) ? cnstVal1 : adj2
        const a3 = (adj3 < 0) ? 0 : (adj3 > cnstVal1) ? cnstVal1 : adj3
        const y1 = minWH * a3 / cnstVal2
        const dx1 = minWH * a2 / cnstVal1
        const x1 = w - dx1
        const dx3 = minWH * a2 / cnstVal2
        const x3 = w - dx3
        const dx2 = minWH * a1 / cnstVal3
        const x2 = x3 - dx2
        const x4 = x3 + dx2
        const dy2 = minWH * a1 / cnstVal2
        const y2 = h - dy2
        pathData = `M 0,${y2} L ${x2},${y2} L ${x2},${y1} L ${x1},${y1} L ${x3},0 L ${w},${y1} L ${x4},${y1} L ${x4},${h} L 0,${h} z`
      }
      break
    case 'bentArrow':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let adj1 = 25000 * RATIO_EMUs_Points
        let adj2 = 25000 * RATIO_EMUs_Points
        let adj3 = 25000 * RATIO_EMUs_Points
        let adj4 = 43750 * RATIO_EMUs_Points
        const cnstVal1 = 50000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            } 
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            } 
            else if (sAdj_name === 'adj3') {
              adj3 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            } 
            else if (sAdj_name === 'adj4') {
              adj4 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
          }
        }
        const minWH = Math.min(w, h)
        const a2 = (adj2 < 0) ? 0 : (adj2 > cnstVal1) ? cnstVal1 : adj2
        const maxAdj1 = 2 * a2
        const a1 = (adj1 < 0) ? 0 : (adj1 > maxAdj1) ? maxAdj1 : adj1
        const a3 = (adj3 < 0) ? 0 : (adj3 > cnstVal1) ? cnstVal1 : adj3
        const th = minWH * a1 / cnstVal2
        const aw2 = minWH * a2 / cnstVal2
        const th2 = th / 2
        const dh2 = aw2 - th2
        const ah = minWH * a3 / cnstVal2
        const bw = w - ah
        const bh = h - dh2
        const bs = (bw < bh) ? bw : bh
        const maxAdj4 = cnstVal2 * bs / minWH
        const a4 = (adj4 < 0) ? 0 : (adj4 > maxAdj4) ? maxAdj4 : adj4
        const bd = minWH * a4 / cnstVal2
        const bd3 = bd - th
        const bd2 = (bd3 > 0) ? bd3 : 0
        const x3 = th + bd2
        const x4 = w - ah
        const y3 = dh2 + th
        const y4 = y3 + dh2
        const y5 = dh2 + bd
        const y6 = y3 + bd2
        pathData = `M 0,${h} L 0,${y5} ${shapeArc(bd, y5, bd, bd, 180, 270, false).replace('M', 'L')} L ${x4},${dh2} L ${x4},0 L ${w},${aw2} L ${x4},${y4} L ${x4},${y3} L ${x3},${y3} ${shapeArc(x3, y6, bd2, bd2, 270, 180, false).replace('M', 'L')} L ${th},${h} z`
      }
      break
    case 'uturnArrow':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let adj1 = 25000 * RATIO_EMUs_Points
        let adj2 = 25000 * RATIO_EMUs_Points
        let adj3 = 25000 * RATIO_EMUs_Points
        let adj4 = 43750 * RATIO_EMUs_Points
        let adj5 = 75000 * RATIO_EMUs_Points
        const cnstVal1 = 25000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj3') {
              adj3 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj4') {
              adj4 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj5') {
              adj5 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
          }
        }
        const minWH = Math.min(w, h)
        const a2 = (adj2 < 0) ? 0 : (adj2 > cnstVal1) ? cnstVal1 : adj2
        const maxAdj1 = 2 * a2
        const a1 = (adj1 < 0) ? 0 : (adj1 > maxAdj1) ? maxAdj1 : adj1
        const q2 = a1 * minWH / h
        const q3 = cnstVal2 - q2
        const maxAdj3 = q3 * h / minWH
        const a3 = (adj3 < 0) ? 0 : (adj3 > maxAdj3) ? maxAdj3 : adj3
        const q1 = a3 + a1
        const minAdj5 = q1 * minWH / h
        const a5 = (adj5 < minAdj5) ? minAdj5 : (adj5 > cnstVal2) ? cnstVal2 : adj5
        const th = minWH * a1 / cnstVal2
        const aw2 = minWH * a2 / cnstVal2
        const th2 = th / 2
        const dh2 = aw2 - th2
        const y5 = h * a5 / cnstVal2
        const ah = minWH * a3 / cnstVal2
        const y4 = y5 - ah
        const x9 = w - dh2
        const bw = x9 / 2
        const bs = (bw < y4) ? bw : y4
        const maxAdj4 = cnstVal2 * bs / minWH
        const a4 = (adj4 < 0) ? 0 : (adj4 > maxAdj4) ? maxAdj4 : adj4
        const bd = minWH * a4 / cnstVal2
        const bd3 = bd - th
        const bd2 = (bd3 > 0) ? bd3 : 0
        const x3 = th + bd2
        const x8 = w - aw2
        const x6 = x8 - aw2
        const x7 = x6 + dh2
        const x4 = x9 - bd
        const x5 = x7 - bd2
        pathData = `M 0,${h} L 0,${bd} ${shapeArc(bd, bd, bd, bd, 180, 270, false).replace('M', 'L')} L ${x4},0 ${shapeArc(x4, bd, bd, bd, 270, 360, false).replace('M', 'L')} L ${x9},${y4} L ${w},${y4} L ${x8},${y5} L ${x6},${y4} L ${x7},${y4} L ${x7},${x3} ${shapeArc(x5, x3, bd2, bd2, 0, -90, false).replace('M', 'L')} L ${x3},${th} ${shapeArc(x3, x3, bd2, bd2, 270, 180, false).replace('M', 'L')} L ${th},${h} z`
      }
      break
    case 'stripedRightArrow':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let adj1 = 50000 * RATIO_EMUs_Points
        let adj2 = 50000 * RATIO_EMUs_Points
        const cnstVal1 = 100000 * RATIO_EMUs_Points
        const cnstVal2 = 200000 * RATIO_EMUs_Points
        const cnstVal3 = 84375 * RATIO_EMUs_Points
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            } 
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
          }
        }
        const vc = h / 2
        const minWH = Math.min(w, h)
        const maxAdj2 = cnstVal3 * w / minWH
        const a1 = (adj1 < 0) ? 0 : (adj1 > cnstVal1) ? cnstVal1 : adj1
        const a2 = (adj2 < 0) ? 0 : (adj2 > maxAdj2) ? maxAdj2 : adj2
        const x4 = minWH * 5 / 32
        const dx5 = minWH * a2 / cnstVal1
        const x5 = w - dx5
        const dy1 = h * a1 / cnstVal2
        const y1 = vc - dy1
        const y2 = vc + dy1
        const ssd8 = minWH / 8,
          ssd16 = minWH / 16,
          ssd32 = minWH / 32
        pathData = `M 0,${y1} L ${ssd32},${y1} L ${ssd32},${y2} L 0,${y2} z M ${ssd16},${y1} L ${ssd8},${y1} L ${ssd8},${y2} L ${ssd16},${y2} z M ${x4},${y1} L ${x5},${y1} L ${x5},0 L ${w},${vc} L ${x5},${h} L ${x5},${y2} L ${x4},${y2} z`
      }
      break
    case 'notchedRightArrow':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let adj1 = 50000 * RATIO_EMUs_Points
        let adj2 = 50000 * RATIO_EMUs_Points
        const cnstVal1 = 100000 * RATIO_EMUs_Points
        const cnstVal2 = 200000 * RATIO_EMUs_Points
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            } 
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
          }
        }
        const vc = h / 2,
          hd2 = vc
        const minWH = Math.min(w, h)
        const maxAdj2 = cnstVal1 * w / minWH
        const a1 = (adj1 < 0) ? 0 : (adj1 > cnstVal1) ? cnstVal1 : adj1
        const a2 = (adj2 < 0) ? 0 : (adj2 > maxAdj2) ? maxAdj2 : adj2
        const dx2 = minWH * a2 / cnstVal1
        const x2 = w - dx2
        const dy1 = h * a1 / cnstVal2
        const y1 = vc - dy1
        const y2 = vc + dy1
        const x1 = dy1 * dx2 / hd2
        pathData = `M 0,${y1} L ${x2},${y1} L ${x2},0 L ${w},${vc} L ${x2},${h} L ${x2},${y2} L 0,${y2} L ${x1},${vc} z`
      }
      break
    case 'homePlate':
      {
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd', 'attrs', 'fmla'])
        let adj = 50000 * RATIO_EMUs_Points
        const cnstVal1 = 100000 * RATIO_EMUs_Points
        if (shapAdjst) {
          adj = parseInt(shapAdjst.substring(4)) * RATIO_EMUs_Points
        }
        const vc = h / 2
        const minWH = Math.min(w, h)
        const maxAdj = cnstVal1 * w / minWH
        const a = (adj < 0) ? 0 : (adj > maxAdj) ? maxAdj : adj
        const dx1 = minWH * a / cnstVal1
        const x1 = w - dx1
        pathData = `M 0,0 L ${x1},0 L ${w},${vc} L ${x1},${h} L 0,${h} z`
      }
      break
    case 'chevron':
      {
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd', 'attrs', 'fmla'])
        let adj = 50000 * RATIO_EMUs_Points
        const cnstVal1 = 100000 * RATIO_EMUs_Points
        if (shapAdjst) {
          adj = parseInt(shapAdjst.substring(4)) * RATIO_EMUs_Points
        }
        const vc = h / 2
        const minWH = Math.min(w, h)
        const maxAdj = cnstVal1 * w / minWH
        const a = (adj < 0) ? 0 : (adj > maxAdj) ? maxAdj : adj
        const x1 = minWH * a / cnstVal1
        const x2 = w - x1
        pathData = `M 0,0 L ${x2},0 L ${w},${vc} L ${x2},${h} L 0,${h} L ${x1},${vc} z`
      }
      break
    case 'rightArrowCallout':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let adj1 = 25000 * RATIO_EMUs_Points
        let adj2 = 25000 * RATIO_EMUs_Points
        let adj3 = 25000 * RATIO_EMUs_Points
        let adj4 = 64977 * RATIO_EMUs_Points
        const cnstVal1 = 50000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        const cnstVal3 = 200000 * RATIO_EMUs_Points
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj3') {
              adj3 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj4') {
              adj4 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
          }
        }
        const vc = h / 2,
          r = w,
          b = h,
          l = 0,
          t = 0
        const ss = Math.min(w, h)
        const maxAdj2 = cnstVal1 * h / ss
        const a2 = (adj2 < 0) ? 0 : (adj2 > maxAdj2) ? maxAdj2 : adj2
        const maxAdj1 = a2 * 2
        const a1 = (adj1 < 0) ? 0 : (adj1 > maxAdj1) ? maxAdj1 : adj1
        const maxAdj3 = cnstVal2 * w / ss
        const a3 = (adj3 < 0) ? 0 : (adj3 > maxAdj3) ? maxAdj3 : adj3
        const q2 = a3 * ss / w
        const maxAdj4 = cnstVal2 - q2
        const a4 = (adj4 < 0) ? 0 : (adj4 > maxAdj4) ? maxAdj4 : adj4
        const dy1 = ss * a2 / cnstVal2
        const dy2 = ss * a1 / cnstVal3
        const y1 = vc - dy1
        const y2 = vc - dy2
        const y3 = vc + dy2
        const y4 = vc + dy1
        const dx3 = ss * a3 / cnstVal2
        const x3 = r - dx3
        const x2 = w * a4 / cnstVal2
        pathData = `M ${l},${t} L ${x2},${t} L ${x2},${y2} L ${x3},${y2} L ${x3},${y1} L ${r},${vc} L ${x3},${y4} L ${x3},${y3} L ${x2},${y3} L ${x2},${b} L ${l},${b} z`
      }
      break
    case 'downArrowCallout':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let adj1 = 25000 * RATIO_EMUs_Points
        let adj2 = 25000 * RATIO_EMUs_Points
        let adj3 = 25000 * RATIO_EMUs_Points
        let adj4 = 64977 * RATIO_EMUs_Points
        const cnstVal1 = 50000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        const cnstVal3 = 200000 * RATIO_EMUs_Points
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj3') {
              adj3 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj4') {
              adj4 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
          }
        }
        const hc = w / 2,
          r = w,
          b = h,
          l = 0,
          t = 0
        const ss = Math.min(w, h)
        const maxAdj2 = cnstVal1 * w / ss
        const a2 = (adj2 < 0) ? 0 : (adj2 > maxAdj2) ? maxAdj2 : adj2
        const maxAdj1 = a2 * 2
        const a1 = (adj1 < 0) ? 0 : (adj1 > maxAdj1) ? maxAdj1 : adj1
        const maxAdj3 = cnstVal2 * h / ss
        const a3 = (adj3 < 0) ? 0 : (adj3 > maxAdj3) ? maxAdj3 : adj3
        const q2 = a3 * ss / h
        const maxAdj4 = cnstVal2 - q2
        const a4 = (adj4 < 0) ? 0 : (adj4 > maxAdj4) ? maxAdj4 : adj4
        const dx1 = ss * a2 / cnstVal2
        const dx2 = ss * a1 / cnstVal3
        const x1 = hc - dx1
        const x2 = hc - dx2
        const x3 = hc + dx2
        const x4 = hc + dx1
        const dy3 = ss * a3 / cnstVal2
        const y3 = b - dy3
        const y2 = h * a4 / cnstVal2
        pathData = `M ${l},${t} L ${r},${t} L ${r},${y2} L ${x3},${y2} L ${x3},${y3} L ${x4},${y3} L ${hc},${b} L ${x1},${y3} L ${x2},${y3} L ${x2},${y2} L ${l},${y2} z`
      }
      break
    case 'leftArrowCallout':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let adj1 = 25000 * RATIO_EMUs_Points
        let adj2 = 25000 * RATIO_EMUs_Points
        let adj3 = 25000 * RATIO_EMUs_Points
        let adj4 = 64977 * RATIO_EMUs_Points
        const cnstVal1 = 50000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        const cnstVal3 = 200000 * RATIO_EMUs_Points
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj3') {
              adj3 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj4') {
              adj4 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
          }
        }
        const vc = h / 2,
          r = w,
          b = h,
          l = 0,
          t = 0
        const ss = Math.min(w, h)
        const maxAdj2 = cnstVal1 * h / ss
        const a2 = (adj2 < 0) ? 0 : (adj2 > maxAdj2) ? maxAdj2 : adj2
        const maxAdj1 = a2 * 2
        const a1 = (adj1 < 0) ? 0 : (adj1 > maxAdj1) ? maxAdj1 : adj1
        const maxAdj3 = cnstVal2 * w / ss
        const a3 = (adj3 < 0) ? 0 : (adj3 > maxAdj3) ? maxAdj3 : adj3
        const q2 = a3 * ss / w
        const maxAdj4 = cnstVal2 - q2
        const a4 = (adj4 < 0) ? 0 : (adj4 > maxAdj4) ? maxAdj4 : adj4
        const dy1 = ss * a2 / cnstVal2
        const dy2 = ss * a1 / cnstVal3
        const y1 = vc - dy1
        const y2 = vc - dy2
        const y3 = vc + dy2
        const y4 = vc + dy1
        const x1 = ss * a3 / cnstVal2
        const dx2 = w * a4 / cnstVal2
        const x2 = r - dx2
        pathData = `M ${l},${vc} L ${x1},${y1} L ${x1},${y2} L ${x2},${y2} L ${x2},${t} L ${r},${t} L ${r},${b} L ${x2},${b} L ${x2},${y3} L ${x1},${y3} L ${x1},${y4} z`
      }
      break
    case 'upArrowCallout':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let adj1 = 25000 * RATIO_EMUs_Points
        let adj2 = 25000 * RATIO_EMUs_Points
        let adj3 = 25000 * RATIO_EMUs_Points
        let adj4 = 64977 * RATIO_EMUs_Points
        const cnstVal1 = 50000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        const cnstVal3 = 200000 * RATIO_EMUs_Points
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj3') {
              adj3 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj4') {
              adj4 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
          }
        }
        const hc = w / 2,
          r = w,
          b = h,
          l = 0,
          t = 0
        const ss = Math.min(w, h)
        const maxAdj2 = cnstVal1 * w / ss
        const a2 = (adj2 < 0) ? 0 : (adj2 > maxAdj2) ? maxAdj2 : adj2
        const maxAdj1 = a2 * 2
        const a1 = (adj1 < 0) ? 0 : (adj1 > maxAdj1) ? maxAdj1 : adj1
        const maxAdj3 = cnstVal2 * h / ss
        const a3 = (adj3 < 0) ? 0 : (adj3 > maxAdj3) ? maxAdj3 : adj3
        const q2 = a3 * ss / h
        const maxAdj4 = cnstVal2 - q2
        const a4 = (adj4 < 0) ? 0 : (adj4 > maxAdj4) ? maxAdj4 : adj4
        const dx1 = ss * a2 / cnstVal2
        const dx2 = ss * a1 / cnstVal3
        const x1 = hc - dx1
        const x2 = hc - dx2
        const x3 = hc + dx2
        const x4 = hc + dx1
        const y1 = ss * a3 / cnstVal2
        const dy2 = h * a4 / cnstVal2
        const y2 = b - dy2
        pathData = `M ${l},${y2} L ${x2},${y2} L ${x2},${y1} L ${x1},${y1} L ${hc},${t} L ${x4},${y1} L ${x3},${y1} L ${x3},${y2} L ${r},${y2} L ${r},${b} L ${l},${b} z`
      }
      break
    case 'leftRightArrowCallout':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let adj1 = 25000 * RATIO_EMUs_Points
        let adj2 = 25000 * RATIO_EMUs_Points
        let adj3 = 25000 * RATIO_EMUs_Points
        let adj4 = 48123 * RATIO_EMUs_Points
        const cnstVal1 = 50000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        const cnstVal3 = 200000 * RATIO_EMUs_Points
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj3') {
              adj3 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj4') {
              adj4 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
          }
        }
        const vc = h / 2,
          hc = w / 2,
          r = w,
          b = h,
          l = 0,
          t = 0
        const ss = Math.min(w, h)
        const maxAdj2 = cnstVal1 * h / ss
        const a2 = (adj2 < 0) ? 0 : (adj2 > maxAdj2) ? maxAdj2 : adj2
        const maxAdj1 = a2 * 2
        const a1 = (adj1 < 0) ? 0 : (adj1 > maxAdj1) ? maxAdj1 : adj1
        const maxAdj3 = cnstVal1 * w / ss
        const a3 = (adj3 < 0) ? 0 : (adj3 > maxAdj3) ? maxAdj3 : adj3
        const q2 = a3 * ss / (w / 2)
        const maxAdj4 = cnstVal2 - q2
        const a4 = (adj4 < 0) ? 0 : (adj4 > maxAdj4) ? maxAdj4 : adj4
        const dy1 = ss * a2 / cnstVal2
        const dy2 = ss * a1 / cnstVal3
        const y1 = vc - dy1
        const y2 = vc - dy2
        const y3 = vc + dy2
        const y4 = vc + dy1
        const x1 = ss * a3 / cnstVal2
        const x4 = r - x1
        const dx2 = w * a4 / cnstVal3
        const x2 = hc - dx2
        const x3 = hc + dx2
        pathData = `M ${l},${vc} L ${x1},${y1} L ${x1},${y2} L ${x2},${y2} L ${x2},${t} L ${x3},${t} L ${x3},${y2} L ${x4},${y2} L ${x4},${y1} L ${r},${vc} L ${x4},${y4} L ${x4},${y3} L ${x3},${y3} L ${x3},${b} L ${x2},${b} L ${x2},${y3} L ${x1},${y3} L ${x1},${y4} z`
      }
      break
    case 'quadArrowCallout':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let adj1 = 18515 * RATIO_EMUs_Points
        let adj2 = 18515 * RATIO_EMUs_Points
        let adj3 = 18515 * RATIO_EMUs_Points
        let adj4 = 48123 * RATIO_EMUs_Points
        const cnstVal1 = 50000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        const cnstVal3 = 200000 * RATIO_EMUs_Points
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj3') {
              adj3 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj4') {
              adj4 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
          }
        }
        const vc = h / 2,
          hc = w / 2,
          r = w,
          b = h,
          l = 0,
          t = 0
        const ss = Math.min(w, h)
        const a2 = (adj2 < 0) ? 0 : (adj2 > cnstVal1) ? cnstVal1 : adj2
        const maxAdj1 = a2 * 2
        const a1 = (adj1 < 0) ? 0 : (adj1 > maxAdj1) ? maxAdj1 : adj1
        const maxAdj3 = cnstVal1 - a2
        const a3 = (adj3 < 0) ? 0 : (adj3 > maxAdj3) ? maxAdj3 : adj3
        const q2 = a3 * 2
        const maxAdj4 = cnstVal2 - q2
        const a4 = (adj4 < a1) ? a1 : (adj4 > maxAdj4) ? maxAdj4 : adj4
        const dx2 = ss * a2 / cnstVal2
        const dx3 = ss * a1 / cnstVal3
        const ah = ss * a3 / cnstVal2
        const dx1 = w * a4 / cnstVal3
        const dy1 = h * a4 / cnstVal3
        const x8 = r - ah
        const x2 = hc - dx1
        const x7 = hc + dx1
        const x3 = hc - dx2
        const x6 = hc + dx2
        const x4 = hc - dx3
        const x5 = hc + dx3
        const y8 = b - ah
        const y2 = vc - dy1
        const y7 = vc + dy1
        const y3 = vc - dx2
        const y6 = vc + dx2
        const y4 = vc - dx3
        const y5 = vc + dx3
        pathData = `M ${l},${vc} L ${ah},${y3} L ${ah},${y4} L ${x2},${y4} L ${x2},${y2} L ${x4},${y2} L ${x4},${ah} L ${x3},${ah} L ${hc},${t} L ${x6},${ah} L ${x5},${ah} L ${x5},${y2} L ${x7},${y2} L ${x7},${y4} L ${x8},${y4} L ${x8},${y3} L ${r},${vc} L ${x8},${y6} L ${x8},${y5} L ${x7},${y5} L ${x7},${y7} L ${x5},${y7} L ${x5},${y8} L ${x6},${y8} L ${hc},${b} L ${x3},${y8} L ${x4},${y8} L ${x4},${y7} L ${x2},${y7} L ${x2},${y5} L ${ah},${y5} L ${ah},${y6} z`
      }
      break
    case 'curvedDownArrow':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let adj1 = 25000 * RATIO_EMUs_Points
        let adj2 = 50000 * RATIO_EMUs_Points
        let adj3 = 25000 * RATIO_EMUs_Points
        const cnstVal1 = 50000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj3') {
              adj3 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
          }
        }
        const wd2 = w / 2,
          r = w,
          b = h,
          t = 0,
          c3d4 = 270,
          cd2 = 180,
          cd4 = 90
        const ss = Math.min(w, h)
        const maxAdj2 = cnstVal1 * w / ss
        const a2 = (adj2 < 0) ? 0 : (adj2 > maxAdj2) ? maxAdj2 : adj2
        const a1 = (adj1 < 0) ? 0 : (adj1 > cnstVal2) ? cnstVal2 : adj1
        const th = ss * a1 / cnstVal2
        const aw = ss * a2 / cnstVal2
        const q1 = (th + aw) / 4
        const wR = wd2 - q1
        const q7 = wR * 2
        const q11 = Math.sqrt(q7 * q7 - th * th)
        const idy = q11 * h / q7
        const maxAdj3 = cnstVal2 * idy / ss
        const a3 = (adj3 < 0) ? 0 : (adj3 > maxAdj3) ? maxAdj3 : adj3
        const ah = ss * a3 / cnstVal2
        const x3 = wR + th
        const q5 = Math.sqrt(h * h - ah * ah)
        const dx = q5 * wR / h
        const x5 = wR + dx
        const x7 = x3 + dx
        const dh = (aw - th) / 2
        const x4 = x5 - dh
        const x8 = x7 + dh
        const x6 = r - (aw / 2)
        const y1 = b - ah
        const swAng = Math.atan(dx / ah)
        const swAngDeg = swAng * 180 / Math.PI
        const mswAng = -swAngDeg
        const dang2 = Math.atan((th / 2) / idy)
        const dang2Deg = dang2 * 180 / Math.PI
        const stAng = c3d4 + swAngDeg
        const stAng2 = c3d4 - dang2Deg
        const swAng2 = dang2Deg - cd4
        const swAng3 = cd4 + dang2Deg
        pathData = `M ${x6},${b} L ${x4},${y1} L ${x5},${y1} ${shapeArc(wR, h, wR, h, stAng, (stAng + mswAng), false).replace('M', 'L')} L ${x3},${t} ${shapeArc(x3, h, wR, h, c3d4, (c3d4 + swAngDeg), false).replace('M', 'L')} L ${x5 + th},${y1} L ${x8},${y1} z M ${x3},${t} ${shapeArc(x3, h, wR, h, stAng2, (stAng2 + swAng2), false).replace('M', 'L')} ${shapeArc(wR, h, wR, h, cd2, (cd2 + swAng3), false).replace('M', 'L')}`
      }
      break
    case 'curvedLeftArrow':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let adj1 = 25000 * RATIO_EMUs_Points
        let adj2 = 50000 * RATIO_EMUs_Points
        let adj3 = 25000 * RATIO_EMUs_Points
        const cnstVal1 = 50000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj3') {
              adj3 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
          }
        }
        const hd2 = h / 2,
          r = w,
          b = h,
          l = 0,
          t = 0,
          c3d4 = 270,
          cd4 = 90
        const ss = Math.min(w, h)
        const maxAdj2 = cnstVal1 * h / ss
        const a2 = (adj2 < 0) ? 0 : (adj2 > maxAdj2) ? maxAdj2 : adj2
        const a1 = (adj1 < 0) ? 0 : (adj1 > a2) ? a2 : adj1
        const th = ss * a1 / cnstVal2
        const aw = ss * a2 / cnstVal2
        const q1 = (th + aw) / 4
        const hR = hd2 - q1
        const q7 = hR * 2
        const q11 = Math.sqrt(q7 * q7 - th * th)
        const iDx = q11 * w / q7
        const maxAdj3 = cnstVal2 * iDx / ss
        const a3 = (adj3 < 0) ? 0 : (adj3 > maxAdj3) ? maxAdj3 : adj3
        const ah = ss * a3 / cnstVal2
        const y3 = hR + th
        const q5 = Math.sqrt(w * w - ah * ah)
        const dy = q5 * hR / w
        const y5 = hR + dy
        const y7 = y3 + dy
        const dh = (aw - th) / 2
        const y4 = y5 - dh
        const y8 = y7 + dh
        const y6 = b - (aw / 2)
        const x1 = l + ah
        const swAng = Math.atan(dy / ah)
        const dang2 = Math.atan((th / 2) / iDx)
        const swAng2 = dang2 - swAng
        const swAngDg = swAng * 180 / Math.PI
        const swAng2Dg = swAng2 * 180 / Math.PI
        pathData = `M ${r},${y3} ${shapeArc(l, hR, w, hR, 0, -cd4, false).replace('M', 'L')} L ${l},${t} ${shapeArc(l, y3, w, hR, c3d4, (c3d4 + cd4), false).replace('M', 'L')} L ${r},${y3} ${shapeArc(l, y3, w, hR, 0, swAngDg, false).replace('M', 'L')} L ${x1},${y7} L ${x1},${y8} L ${l},${y6} L ${x1},${y4} L ${x1},${y5} ${shapeArc(l, hR, w, hR, swAngDg, (swAngDg + swAng2Dg), false).replace('M', 'L')} ${shapeArc(l, hR, w, hR, 0, -cd4, false).replace('M', 'L')} ${shapeArc(l, y3, w, hR, c3d4, (c3d4 + cd4), false).replace('M', 'L')}`
      }
      break
    case 'curvedRightArrow':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let adj1 = 25000 * RATIO_EMUs_Points
        let adj2 = 50000 * RATIO_EMUs_Points
        let adj3 = 25000 * RATIO_EMUs_Points
        const cnstVal1 = 50000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj3') {
              adj3 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
          }
        }
        const hd2 = h / 2,
          r = w,
          b = h,
          l = 0,
          cd2 = 180,
          cd4 = 90,
          c3d4 = 270
        const ss = Math.min(w, h)
        const maxAdj2 = cnstVal1 * h / ss
        const a2 = (adj2 < 0) ? 0 : (adj2 > maxAdj2) ? maxAdj2 : adj2
        const a1 = (adj1 < 0) ? 0 : (adj1 > a2) ? a2 : adj1
        const th = ss * a1 / cnstVal2
        const aw = ss * a2 / cnstVal2
        const q1 = (th + aw) / 4
        const hR = hd2 - q1
        const q7 = hR * 2
        const q11 = Math.sqrt(q7 * q7 - th * th)
        const iDx = q11 * w / q7
        const maxAdj3 = cnstVal2 * iDx / ss
        const a3 = (adj3 < 0) ? 0 : (adj3 > maxAdj3) ? maxAdj3 : adj3
        const ah = ss * a3 / cnstVal2
        const y3 = hR + th
        const q5 = Math.sqrt(w * w - ah * ah)
        const dy = q5 * hR / w
        const y5 = hR + dy
        const y7 = y3 + dy
        const dh = (aw - th) / 2
        const y4 = y5 - dh
        const y8 = y7 + dh
        const y6 = b - (aw / 2)
        const x1 = r - ah
        const swAng = Math.atan(dy / ah)
        const stAng = Math.PI - swAng
        const mswAng = -swAng
        const dang2 = Math.atan((th / 2) / iDx)
        const swAng2 = dang2 - Math.PI / 2
        const stAngDg = stAng * 180 / Math.PI
        const mswAngDg = mswAng * 180 / Math.PI
        const swAngDg = swAng * 180 / Math.PI
        const swAng2dg = swAng2 * 180 / Math.PI
        pathData = `M ${l},${hR} ${shapeArc(w, hR, w, hR, cd2, cd2 + mswAngDg, false).replace('M', 'L')} L ${x1},${y5} L ${x1},${y4} L ${r},${y6} L ${x1},${y8} L ${x1},${y7} ${shapeArc(w, y3, w, hR, stAngDg, stAngDg + swAngDg, false).replace('M', 'L')} L ${l},${hR} ${shapeArc(w, hR, w, hR, cd2, cd2 + cd4, false).replace('M', 'L')} L ${r},${th} ${shapeArc(w, y3, w, hR, c3d4, c3d4 + swAng2dg, false).replace('M', 'L')}`
      }
      break
    case 'curvedUpArrow':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let adj1 = 25000 * RATIO_EMUs_Points
        let adj2 = 50000 * RATIO_EMUs_Points
        let adj3 = 25000 * RATIO_EMUs_Points
        const cnstVal1 = 50000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj3') {
              adj3 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
          }
        }
        const wd2 = w / 2,
          r = w,
          b = h,
          t = 0,
          cd2 = 180,
          cd4 = 90
        const ss = Math.min(w, h)
        const maxAdj2 = cnstVal1 * w / ss
        const a2 = (adj2 < 0) ? 0 : (adj2 > maxAdj2) ? maxAdj2 : adj2
        const a1 = (adj1 < 0) ? 0 : (adj1 > cnstVal2) ? cnstVal2 : adj1
        const th = ss * a1 / cnstVal2
        const aw = ss * a2 / cnstVal2
        const q1 = (th + aw) / 4
        const wR = wd2 - q1
        const q7 = wR * 2
        const q11 = Math.sqrt(q7 * q7 - th * th)
        const idy = q11 * h / q7
        const maxAdj3 = cnstVal2 * idy / ss
        const a3 = (adj3 < 0) ? 0 : (adj3 > maxAdj3) ? maxAdj3 : adj3
        const ah = ss * a3 / cnstVal2
        const x3 = wR + th
        const q5 = Math.sqrt(h * h - ah * ah)
        const dx = q5 * wR / h
        const x5 = wR + dx
        const x7 = x3 + dx
        const dh = (aw - th) / 2
        const x4 = x5 - dh
        const x8 = x7 + dh
        const x6 = r - (aw / 2)
        const y1 = t + ah
        const swAng = Math.atan(dx / ah)
        const dang2 = Math.atan((th / 2) / idy)
        const swAng2 = dang2 - swAng
        const stAng3 = Math.PI / 2 - swAng
        const stAng2 = Math.PI / 2 - dang2
        const stAng2dg = stAng2 * 180 / Math.PI
        const swAng2dg = swAng2 * 180 / Math.PI
        const stAng3dg = stAng3 * 180 / Math.PI
        const swAngDg = swAng * 180 / Math.PI
        pathData = `${shapeArc(wR, 0, wR, h, stAng2dg, stAng2dg + swAng2dg, false)} L ${x5},${y1} L ${x4},${y1} L ${x6},${t} L ${x8},${y1} L ${x7},${y1} ${shapeArc(x3, 0, wR, h, stAng3dg, stAng3dg + swAngDg, false).replace('M', 'L')} L ${wR},${b} ${shapeArc(wR, 0, wR, h, cd4, cd2, false).replace('M', 'L')} L ${th},${t} ${shapeArc(x3, 0, wR, h, cd2, cd4, false).replace('M', 'L')}`
      }
      break
    case 'mathDivide':
    case 'mathEqual':
    case 'mathMinus':
    case 'mathMultiply':
    case 'mathNotEqual':
    case 'mathPlus':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let adj1, adj2, adj3
        if (shapAdjst_ary) {
          if (Array.isArray(shapAdjst_ary)) {
            for (const adj of shapAdjst_ary) {
              const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
              if (sAdj_name === 'adj1') {
                adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4))
              }
              else if (sAdj_name === 'adj2') {
                adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4))
              }
              else if (sAdj_name === 'adj3') {
                adj3 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4))
              }
            }
          } 
          else {
            adj1 = parseInt(getTextByPathList(shapAdjst_ary, ['attrs', 'fmla']).substring(4))
          }
        }
        const cnstVal1 = 50000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        const cnstVal3 = 200000 * RATIO_EMUs_Points
        const hc = w / 2,
          vc = h / 2,
          hd2 = h / 2
        if (shapType === 'mathNotEqual') {
          if (adj1 === undefined) adj1 = 23520
          if (adj2 === undefined) adj2 = 110 * 60000
          if (adj3 === undefined) adj3 = 11760
          adj1 *= RATIO_EMUs_Points
          adj2 = (adj2 / 60000) * Math.PI / 180
          adj3 *= RATIO_EMUs_Points
          const angVal1 = 70 * Math.PI / 180,
            angVal2 = 110 * Math.PI / 180
          const cnstVal4 = 73490 * RATIO_EMUs_Points
          const a1 = (adj1 < 0) ? 0 : (adj1 > cnstVal1) ? cnstVal1 : adj1
          const crAng = (adj2 < angVal1) ? angVal1 : (adj2 > angVal2) ? angVal2 : adj2
          const maxAdj3 = cnstVal2 - (a1 * 2)
          const a3 = (adj3 < 0) ? 0 : (adj3 > maxAdj3) ? maxAdj3 : adj3
          const dy1 = h * a1 / cnstVal2
          const dy2 = h * a3 / cnstVal3
          const dx1 = w * cnstVal4 / cnstVal3
          const x1 = hc - dx1
          const x8 = hc + dx1
          const y2 = vc - dy2
          const y3 = vc + dy2
          const y1 = y2 - dy1
          const y4 = y3 + dy1
          const cadj2 = crAng - Math.PI / 2
          const xadj2 = hd2 * Math.tan(cadj2)
          const len = Math.sqrt(xadj2 * xadj2 + hd2 * hd2)
          const bhw = len * dy1 / hd2
          const bhw2 = bhw / 2
          const x7 = hc + xadj2 - bhw2
          const dx67 = xadj2 * y1 / hd2
          const x6 = x7 - dx67
          const dx57 = xadj2 * y2 / hd2
          const x5 = x7 - dx57
          const dx47 = xadj2 * y3 / hd2
          const x4 = x7 - dx47
          const dx37 = xadj2 * y4 / hd2
          const x3 = x7 - dx37
          const rx6 = x6 + bhw
          const rx5 = x5 + bhw
          const rx4 = x4 + bhw
          const rx3 = x3 + bhw
          const dx7 = dy1 * hd2 / len
          const rxt = x7 + dx7
          const lxt = (x7 + bhw) - dx7
          const rx = (cadj2 > 0) ? rxt : (x7 + bhw)
          const lx = (cadj2 > 0) ? x7 : lxt
          const dy3 = dy1 * xadj2 / len
          const ry = (cadj2 > 0) ? dy3 : 0
          const ly = (cadj2 > 0) ? 0 : -dy3
          const dlx = w - rx
          const drx = w - lx
          const dly = h - ry
          const dry = h - ly
          pathData = `M ${x1},${y1} L ${x6},${y1} L ${lx},${ly} L ${rx},${ry} L ${rx6},${y1} L ${x8},${y1} L ${x8},${y2} L ${rx5},${y2} L ${rx4},${y3} L ${x8},${y3} L ${x8},${y4} L ${rx3},${y4} L ${drx},${dry} L ${dlx},${dly} L ${x3},${y4} L ${x1},${y4} L ${x1},${y3} L ${x4},${y3} L ${x5},${y2} L ${x1},${y2} z`
        } 
        else if (shapType === 'mathDivide') {
          if (adj1 === undefined) adj1 = 23520
          if (adj2 === undefined) adj2 = 5880
          if (adj3 === undefined) adj3 = 11760
          adj1 *= RATIO_EMUs_Points
          adj2 *= RATIO_EMUs_Points
          adj3 *= RATIO_EMUs_Points
          const cnstVal4 = 1000 * RATIO_EMUs_Points
          const cnstVal5 = 36745 * RATIO_EMUs_Points
          const cnstVal6 = 73490 * RATIO_EMUs_Points
          const a1 = (adj1 < cnstVal4) ? cnstVal4 : (adj1 > cnstVal5) ? cnstVal5 : adj1
          const ma3h = (cnstVal6 - a1) / 4
          const ma3w = cnstVal5 * w / h
          const maxAdj3 = (ma3h < ma3w) ? ma3h : ma3w
          const a3 = (adj3 < cnstVal4) ? cnstVal4 : (adj3 > maxAdj3) ? maxAdj3 : adj3
          const maxAdj2 = cnstVal6 - (4 * a3) - a1
          const a2 = (adj2 < 0) ? 0 : (adj2 > maxAdj2) ? maxAdj2 : adj2
          const dy1 = h * a1 / cnstVal3
          const yg = h * a2 / cnstVal2
          const rad = h * a3 / cnstVal2
          const dx1 = w * cnstVal6 / cnstVal3
          const y3 = vc - dy1
          const y4 = vc + dy1
          const y2 = y3 - (yg + rad)
          const y1 = y2 - rad
          const y5 = h - y1
          const x1 = hc - dx1
          const x3 = hc + dx1
          pathData = `M ${hc},${y1} A ${rad},${rad} 0 1,0 ${hc},${y1 + 2 * rad} A ${rad},${rad} 0 1,0 ${hc},${y1} z M ${hc},${y5} A ${rad},${rad} 0 1,1 ${hc},${y5 - 2 * rad} A ${rad},${rad} 0 1,1 ${hc},${y5} z M ${x1},${y3} L ${x3},${y3} L ${x3},${y4} L ${x1},${y4} z`
        } 
        else if (shapType === 'mathEqual') {
          if (adj1 === undefined) adj1 = 23520
          if (adj2 === undefined) adj2 = 11760
          adj1 *= RATIO_EMUs_Points
          adj2 *= RATIO_EMUs_Points
          const cnstVal5 = 36745 * RATIO_EMUs_Points
          const cnstVal6 = 73490 * RATIO_EMUs_Points
          const a1 = (adj1 < 0) ? 0 : (adj1 > cnstVal5) ? cnstVal5 : adj1
          const mAdj2 = cnstVal2 - (a1 * 2)
          const a2 = (adj2 < 0) ? 0 : (adj2 > mAdj2) ? mAdj2 : adj2
          const dy1 = h * a1 / cnstVal2
          const dy2 = h * a2 / cnstVal3
          const dx1 = w * cnstVal6 / cnstVal3
          const y2 = vc - dy2
          const y3 = vc + dy2
          const y1 = y2 - dy1
          const y4 = y3 + dy1
          const x1 = hc - dx1
          const x2 = hc + dx1
          pathData = `M ${x1},${y1} L ${x2},${y1} L ${x2},${y2} L ${x1},${y2} z M ${x1},${y3} L ${x2},${y3} L ${x2},${y4} L ${x1},${y4} z`
        } 
        else if (shapType === 'mathMinus') {
          if (adj1 === undefined) adj1 = 23520
          adj1 *= RATIO_EMUs_Points
          const cnstVal6 = 73490 * RATIO_EMUs_Points
          const a1 = (adj1 < 0) ? 0 : (adj1 > cnstVal2) ? cnstVal2 : adj1
          const dy1 = h * a1 / cnstVal3
          const dx1 = w * cnstVal6 / cnstVal3
          const y1 = vc - dy1
          const y2 = vc + dy1
          const x1 = hc - dx1
          const x2 = hc + dx1
          pathData = `M ${x1},${y1} L ${x2},${y1} L ${x2},${y2} L ${x1},${y2} z`
        } 
        else if (shapType === 'mathMultiply') {
          if (adj1 === undefined) adj1 = 23520
          adj1 *= RATIO_EMUs_Points
          const cnstVal6 = 51965 * RATIO_EMUs_Points
          const ss = Math.min(w, h)
          const a1 = (adj1 < 0) ? 0 : (adj1 > cnstVal6) ? cnstVal6 : adj1
          const th = ss * a1 / cnstVal2
          const a = Math.atan(h / w)
          const sa = Math.sin(a)
          const ca = Math.cos(a)
          const ta = Math.tan(a)
          const dl = Math.sqrt(w * w + h * h)
          const lM = dl - (dl * cnstVal6 / cnstVal2)
          const xM = ca * lM / 2
          const yM = sa * lM / 2
          const dxAM = sa * th / 2
          const dyAM = ca * th / 2
          const xA = xM - dxAM
          const yA = yM + dyAM
          const xB = xM + dxAM
          const yB = yM - dyAM
          const yC = (hc - xB) * ta + yB
          const xD = w - xB
          const xE = w - xA
          const xF = xE - ((vc - yA) / ta)
          const xL = xA + ((vc - yA) / ta)
          const yG = h - yA
          const yH = h - yB
          const yI = h - yC
          pathData = `M ${xA},${yA} L ${xB},${yB} L ${hc},${yC} L ${xD},${yB} L ${xE},${yA} L ${xF},${vc} L ${xE},${yG} L ${xD},${yH} L ${hc},${yI} L ${xB},${yH} L ${xA},${yG} L ${xL},${vc} z`
        } 
        else if (shapType === 'mathPlus') {
          if (adj1 === undefined) adj1 = 23520
          adj1 *= RATIO_EMUs_Points
          const cnstVal6 = 73490 * RATIO_EMUs_Points
          const ss = Math.min(w, h)
          const a1 = (adj1 < 0) ? 0 : (adj1 > cnstVal6) ? cnstVal6 : adj1
          const dx1 = w * cnstVal6 / cnstVal3
          const dy1 = h * cnstVal6 / cnstVal3
          const dx2 = ss * a1 / cnstVal3
          const x1 = hc - dx1
          const x2 = hc - dx2
          const x3 = hc + dx2
          const x4 = hc + dx1
          const y1 = vc - dy1
          const y2 = vc - dx2
          const y3 = vc + dx2
          const y4 = vc + dy1
          pathData = `M ${x1},${y2} L ${x2},${y2} L ${x2},${y1} L ${x3},${y1} L ${x3},${y2} L ${x4},${y2} L ${x4},${y3} L ${x3},${y3} L ${x3},${y4} L ${x2},${y4} L ${x2},${y3} L ${x1},${y3} z`
        }
      }
      break
    case 'can':
    case 'flowChartMagneticDisk':
    case 'flowChartMagneticDrum':
      {
        const shapAdjst = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd', 'attrs', 'fmla'])
        let adj = 25000 * RATIO_EMUs_Points
        const cnstVal1 = 50000 * RATIO_EMUs_Points
        const cnstVal2 = 200000 * RATIO_EMUs_Points
        if (shapAdjst) {
          adj = parseInt(shapAdjst.substring(4)) * RATIO_EMUs_Points
        }
        if (shapType === 'flowChartMagneticDisk' || shapType === 'flowChartMagneticDrum') {
          adj = 50000 * RATIO_EMUs_Points
        }
        const ss = Math.min(w, h)
        const maxAdj = cnstVal1 * h / ss
        const a = (adj < 0) ? 0 : (adj > maxAdj) ? maxAdj : adj
        const y1 = ss * a / cnstVal2
        const y3 = h - y1
        const cd2 = 180,
          wd2 = w / 2
        let dVal = `${shapeArc(wd2, y1, wd2, y1, 0, cd2, false)} ${shapeArc(wd2, y1, wd2, y1, cd2, cd2 + cd2, false).replace('M', 'L')} L ${w},${y3} ${shapeArc(wd2, y3, wd2, y1, 0, cd2, false).replace('M', 'L')} L 0,${y1}`

        if (shapType === 'flowChartMagneticDrum') {
          dVal = dVal.replace(/([MLQC])\s*([-\d.e]+)\s*([-\d.e]+)/gi, (match, command, x, y) => {
            const newX = w / 2 - (parseFloat(y) - h / 2)
            const newY = h / 2 + (parseFloat(x) - w / 2)
            return `${command}${newX} ${newY}`
          }).replace(/([MLQC])\s*([-\d.e]+)\s*([-\d.e]+)\s*([-\d.e]+)\s*([-\d.e]+)/gi, (match, command, c1x, c1y, x, y) => {
            const newC1X = w / 2 - (parseFloat(c1y) - h / 2)
            const newC1Y = h / 2 + (parseFloat(c1x) - w / 2)
            const newX = w / 2 - (parseFloat(y) - h / 2)
            const newY = h / 2 + (parseFloat(x) - w / 2)
            return `${command}${newC1X} ${newC1Y} ${newX} ${newY}`
          })
        }
        pathData = dVal
      }
      break
    case 'swooshArrow':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        const refr = RATIO_EMUs_Points
        let adj1 = 25000 * refr
        let adj2 = 16667 * refr
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * refr
            } 
            else if (sAdj_name === 'adj2') {
              adj2 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * refr
            }
          }
        }
        const cnstVal1 = 1 * refr
        const cnstVal2 = 70000 * refr
        const cnstVal3 = 75000 * refr
        const cnstVal4 = 100000 * refr
        const ss = Math.min(w, h)
        const ssd8 = ss / 8
        const hd6 = h / 6
        const a1 = (adj1 < cnstVal1) ? cnstVal1 : (adj1 > cnstVal3) ? cnstVal3 : adj1
        const maxAdj2 = cnstVal2 * w / ss
        const a2 = (adj2 < 0) ? 0 : (adj2 > maxAdj2) ? maxAdj2 : adj2
        const ad1 = h * a1 / cnstVal4
        const ad2 = ss * a2 / cnstVal4
        const xB = w - ad2
        const yB = ssd8
        const alfa = (Math.PI / 2) / 14
        const dx0 = ssd8 * Math.tan(alfa)
        const xC = xB - dx0
        const dx1 = ad1 * Math.tan(alfa)
        const yF = yB + ad1
        const xF = xB + dx1
        const xE = xF + dx0
        const yE = yF + ssd8
        const dy22 = yE / 2
        const dy3 = h / 20
        const yD = dy22 - dy3
        const yP1 = hd6 + (hd6)
        const xP1 = w / 6
        const yP2 = yF + (hd6 / 2)
        const xP2 = w / 4
        pathData = `M 0,${h} Q ${xP1},${yP1} ${xB},${yB} L ${xC},0 L ${w},${yD} L ${xE},${yE} L ${xF},${yF} Q ${xP2},${yP2} 0,${h} z`
      }
      break
    case 'circularArrow':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let adj1 = 12500 * RATIO_EMUs_Points
        let adj2 = (1142319 / 60000) * Math.PI / 180
        let adj3 = (20457681 / 60000) * Math.PI / 180
        let adj4 = (10800000 / 60000) * Math.PI / 180
        let adj5 = 12500 * RATIO_EMUs_Points
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj2') {
              adj2 = (parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) / 60000) * Math.PI / 180
            }
            else if (sAdj_name === 'adj3') {
              adj3 = (parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) / 60000) * Math.PI / 180
            }
            else if (sAdj_name === 'adj4') {
              adj4 = (parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) / 60000) * Math.PI / 180
            }
            else if (sAdj_name === 'adj5') {
              adj5 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
          }
        }
        const hc = w / 2,
          vc = h / 2,
          wd2 = w / 2,
          hd2 = h / 2
        const ss = Math.min(w, h)
        const cnstVal1 = 25000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        const rdAngVal1 = (1 / 60000) * Math.PI / 180
        const rdAngVal2 = (21599999 / 60000) * Math.PI / 180
        const rdAngVal3 = 2 * Math.PI
        const a5 = (adj5 < 0) ? 0 : (adj5 > cnstVal1) ? cnstVal1 : adj5
        const maxAdj1 = a5 * 2
        const a1 = (adj1 < 0) ? 0 : (adj1 > maxAdj1) ? maxAdj1 : adj1
        const enAng = (adj3 < rdAngVal1) ? rdAngVal1 : (adj3 > rdAngVal2) ? rdAngVal2 : adj3
        const stAng = (adj4 < 0) ? 0 : (adj4 > rdAngVal2) ? rdAngVal2 : adj4
        const th = ss * a1 / cnstVal2
        const thh = ss * a5 / cnstVal2
        const th2 = th / 2
        const rw1 = wd2 + th2 - thh
        const rh1 = hd2 + th2 - thh
        const rw2 = rw1 - th
        const rh2 = rh1 - th
        const rw3 = rw2 + th2
        const rh3 = rh2 + th2
        const wtH = rw3 * Math.sin(enAng)
        const htH = rh3 * Math.cos(enAng)
        const dxH = rw3 * Math.cos(Math.atan2(wtH, htH))
        const dyH = rh3 * Math.sin(Math.atan2(wtH, htH))
        const xH = hc + dxH
        const yH = vc + dyH
        const rI = Math.min(rw2, rh2)
        const u8 = 1 - (((dxH * dxH - rI * rI) * (dyH * dyH - rI * rI)) / (dxH * dxH * dyH * dyH))
        const u9 = Math.sqrt(u8)
        const u12 = (1 + u9) / (((dxH * dxH - rI * rI) / dxH) / dyH)
        const u15 = Math.atan2(u12, 1) > 0 ? Math.atan2(u12, 1) : Math.atan2(u12, 1) + rdAngVal3
        const u18 = (u15 - enAng > 0) ? u15 - enAng : u15 - enAng + rdAngVal3
        const u21 = (u18 - Math.PI > 0) ? u18 - rdAngVal3 : u18
        const maxAng = Math.abs(u21)
        const aAng = (adj2 < 0) ? 0 : (adj2 > maxAng) ? maxAng : adj2
        const ptAng = enAng + aAng
        const wtA = rw3 * Math.sin(ptAng)
        const htA = rh3 * Math.cos(ptAng)
        const dxA = rw3 * Math.cos(Math.atan2(wtA, htA))
        const dyA = rh3 * Math.sin(Math.atan2(wtA, htA))
        const xA = hc + dxA
        const yA = vc + dyA
        const dxG = thh * Math.cos(ptAng)
        const dyG = thh * Math.sin(ptAng)
        const xG = xH + dxG
        const yG = yH + dyG
        const dxB = thh * Math.cos(ptAng)
        const dyB = thh * Math.sin(ptAng)
        const xB = xH - dxB
        const yB = yH - dyB
        const sx1 = xB - hc
        const sy1 = yB - vc
        const sx2 = xG - hc
        const sy2 = yG - vc
        const rO = Math.min(rw1, rh1)
        const x1O = sx1 * rO / rw1
        const y1O = sy1 * rO / rh1
        const x2O = sx2 * rO / rw1
        const y2O = sy2 * rO / rh1
        const dxO = x2O - x1O
        const dyO = y2O - y1O
        const dO = Math.sqrt(dxO * dxO + dyO * dyO)
        const DO = x1O * y2O - x2O * y1O
        const sdelO = Math.sqrt(Math.max(0, rO * rO * dO * dO - DO * DO))
        const sdyO = (dyO * -1 > 0) ? -1 : 1
        const dxF1 = (DO * dyO + sdyO * dxO * sdelO) / (dO * dO)
        const dxF2 = (DO * dyO - sdyO * dxO * sdelO) / (dO * dO)
        const dyF1 = (-DO * dxO + Math.abs(dyO) * sdelO) / (dO * dO)
        const dyF2 = (-DO * dxO - Math.abs(dyO) * sdelO) / (dO * dO)
        const q22 = Math.sqrt((x2O - dxF2) ** 2 + (y2O - dyF2) ** 2) - Math.sqrt((x2O - dxF1) ** 2 + (y2O - dyF1) ** 2)
        const dxF = (q22 > 0) ? dxF1 : dxF2
        const dyF = (q22 > 0) ? dyF1 : dyF2
        const xF = hc + (dxF * rw1 / rO)
        const yF = vc + (dyF * rh1 / rO)
        const x1I = sx1 * rI / rw2
        const y1I = sy1 * rI / rh2
        const x2I = sx2 * rI / rw2
        const y2I = sy2 * rI / rh2
        const dxI = x2I - x1I
        const dyI = y2I - y1I
        const dI = Math.sqrt(dxI * dxI + dyI * dyI)
        const DI = x1I * y2I - x2I * y1I
        const sdelI = Math.sqrt(Math.max(0, rI * rI * dI * dI - DI * DI))
        const dxC1 = (DI * dyI + sdyO * dxI * sdelI) / (dI * dI)
        const dxC2 = (DI * dyI - sdyO * dxI * sdelI) / (dI * dI)
        const dyC1 = (-DI * dxI + Math.abs(dyI) * sdelI) / (dI * dI)
        const dyC2 = (-DI * dxI - Math.abs(dyI) * sdelI) / (dI * dI)
        const v22 = Math.sqrt((x1I - dxC2) ** 2 + (y1I - dyC2) ** 2) - Math.sqrt((x1I - dxC1) ** 2 + (y1I - dyC1) ** 2)
        const dxC = (v22 > 0) ? dxC1 : dxC2
        const dyC = (v22 > 0) ? dyC1 : dyC2
        const xC = hc + (dxC * rw2 / rI)
        const yC = vc + (dyC * rh2 / rI)
        const ist0 = Math.atan2(dyC * rh2 / rI, dxC * rw2 / rI)
        const istAng = (ist0 > 0) ? ist0 : ist0 + rdAngVal3
        const isw1 = stAng - istAng
        const iswAng = (isw1 > 0) ? isw1 - rdAngVal3 : isw1
        const p5 = Math.sqrt((xF - xC) ** 2 + (yF - yC) ** 2) / 2 - thh
        const xGp = (p5 > 0) ? xF : xG
        const yGp = (p5 > 0) ? yF : yG
        const xBp = (p5 > 0) ? xC : xB
        const yBp = (p5 > 0) ? yC : yB
        const en0 = Math.atan2((yF - vc), (xF - hc))
        const en2 = (en0 > 0) ? en0 : en0 + rdAngVal3
        const sw0 = en2 - stAng
        const swAng = (sw0 > 0) ? sw0 : sw0 + rdAngVal3
        const strtAng = stAng * 180 / Math.PI
        const endAngVal = strtAng + (swAng * 180 / Math.PI)
        const stiAng = istAng * 180 / Math.PI
        const ediAng = stiAng + (iswAng * 180 / Math.PI)
        pathData = `${shapeArc(w / 2, h / 2, rw1, rh1, strtAng, endAngVal, false)} L ${xGp},${yGp} L ${xA},${yA} L ${xBp},${yBp} L ${xC},${yC} ${shapeArc(w / 2, h / 2, rw2, rh2, stiAng, ediAng, false).replace('M', 'L')} z`
      }
      break
    case 'leftCircularArrow':
      {
        const shapAdjst_ary = getTextByPathList(node, ['p:spPr', 'a:prstGeom', 'a:avLst', 'a:gd'])
        let adj1 = 12500 * RATIO_EMUs_Points
        let adj2 = (-1142319 / 60000) * Math.PI / 180
        let adj3 = (1142319 / 60000) * Math.PI / 180
        let adj4 = (10800000 / 60000) * Math.PI / 180
        let adj5 = 12500 * RATIO_EMUs_Points
        if (shapAdjst_ary) {
          for (const adj of shapAdjst_ary) {
            const sAdj_name = getTextByPathList(adj, ['attrs', 'name'])
            if (sAdj_name === 'adj1') {
              adj1 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
            else if (sAdj_name === 'adj2') {
              adj2 = (parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) / 60000) * Math.PI / 180
            }
            else if (sAdj_name === 'adj3') {
              adj3 = (parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) / 60000) * Math.PI / 180
            }
            else if (sAdj_name === 'adj4') {
              adj4 = (parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) / 60000) * Math.PI / 180
            }
            else if (sAdj_name === 'adj5') {
              adj5 = parseInt(getTextByPathList(adj, ['attrs', 'fmla']).substring(4)) * RATIO_EMUs_Points
            }
          }
        }
        const hc = w / 2,
          vc = h / 2,
          wd2 = w / 2,
          hd2 = h / 2
        const ss = Math.min(w, h)
        const cnstVal1 = 25000 * RATIO_EMUs_Points
        const cnstVal2 = 100000 * RATIO_EMUs_Points
        const rdAngVal1 = (1 / 60000) * Math.PI / 180
        const rdAngVal2 = (21599999 / 60000) * Math.PI / 180
        const rdAngVal3 = 2 * Math.PI
        const a5 = (adj5 < 0) ? 0 : (adj5 > cnstVal1) ? cnstVal1 : adj5
        const maxAdj1 = a5 * 2
        const a1 = (adj1 < 0) ? 0 : (adj1 > maxAdj1) ? maxAdj1 : adj1
        const enAng = (adj3 < rdAngVal1) ? rdAngVal1 : (adj3 > rdAngVal2) ? rdAngVal2 : adj3
        const stAng = (adj4 < 0) ? 0 : (adj4 > rdAngVal2) ? rdAngVal2 : adj4
        const th = ss * a1 / cnstVal2
        const thh = ss * a5 / cnstVal2
        const th2 = th / 2
        const rw1 = wd2 + th2 - thh
        const rh1 = hd2 + th2 - thh
        const rw2 = rw1 - th
        const rh2 = rh1 - th
        const rw3 = rw2 + th2
        const rh3 = rh2 + th2
        const dxH = rw3 * Math.cos(enAng)
        const dyH = rh3 * Math.sin(enAng)
        const xH = hc + dxH
        const yH = vc + dyH
        const rI = Math.min(rw2, rh2)
        const u8 = 1 - (((dxH * dxH - rI * rI) * (dyH * dyH - rI * rI)) / (dxH * dxH * dyH * dyH))
        const u9 = Math.sqrt(u8)
        const u12 = (1 + u9) / (((dxH * dxH - rI * rI) / dxH) / dyH)
        const u15 = Math.atan2(u12, 1) > 0 ? Math.atan2(u12, 1) : Math.atan2(u12, 1) + rdAngVal3
        const u18 = (u15 - enAng > 0) ? u15 - enAng : u15 - enAng + rdAngVal3
        const u21 = (u18 - Math.PI > 0) ? u18 - rdAngVal3 : u18
        const minAng = -Math.abs(u21)
        const aAng = (adj2 < minAng) ? minAng : (adj2 > 0) ? 0 : adj2
        const ptAng = enAng + aAng
        const dxA = rw3 * Math.cos(ptAng)
        const dyA = rh3 * Math.sin(ptAng)
        const xA = hc + dxA
        const yA = vc + dyA
        const dxE = rw1 * Math.cos(stAng)
        const dyE = rh1 * Math.sin(stAng)
        const xE = hc + dxE
        const yE = vc + dyE
        const dxD = rw2 * Math.cos(stAng)
        const dyD = rh2 * Math.sin(stAng)
        const xD = hc + dxD
        const yD = vc + dyD
        const dxG = thh * Math.cos(ptAng)
        const dyG = thh * Math.sin(ptAng)
        const xG = xH + dxG
        const yG = yH + dyG
        const dxB = thh * Math.cos(ptAng)
        const dyB = thh * Math.sin(ptAng)
        const xB = xH - dxB
        const yB = yH - dyB
        const sx1 = xB - hc
        const sy1 = yB - vc
        const sx2 = xG - hc
        const sy2 = yG - vc
        const rO = Math.min(rw1, rh1)
        const x1O = sx1 * rO / rw1
        const y1O = sy1 * rO / rh1
        const x2O = sx2 * rO / rw1
        const y2O = sy2 * rO / rh1
        const dxO = x2O - x1O
        const dyO = y2O - y1O
        const dO = Math.sqrt(dxO * dxO + dyO * dyO)
        const DO = x1O * y2O - x2O * y1O
        const sdelO = Math.sqrt(Math.max(0, rO * rO * dO * dO - DO * DO))
        const sdyO = (dyO * -1 > 0) ? -1 : 1
        const dxF1 = (DO * dyO + sdyO * dxO * sdelO) / (dO * dO)
        const dxF2 = (DO * dyO - sdyO * dxO * sdelO) / (dO * dO)
        const dyF1 = (-DO * dxO + Math.abs(dyO) * sdelO) / (dO * dO)
        const dyF2 = (-DO * dxO - Math.abs(dyO) * sdelO) / (dO * dO)
        const q22 = Math.sqrt((x2O - dxF2) ** 2 + (y2O - dyF2) ** 2) - Math.sqrt((x2O - dxF1) ** 2 + (y2O - dyF1) ** 2)
        const dxF = (q22 > 0) ? dxF1 : dxF2
        const dyF = (q22 > 0) ? dyF1 : dyF2
        const xF = hc + (dxF * rw1 / rO)
        const yF = vc + (dyF * rh1 / rO)
        const x1I = sx1 * rI / rw2
        const y1I = sy1 * rI / rh2
        const x2I = sx2 * rI / rw2
        const y2I = sy2 * rI / rh2
        const dxI = x2I - x1I
        const dyI = y2I - y1I
        const dI = Math.sqrt(dxI * dxI + dyI * dyI)
        const DI = x1I * y2I - x2I * y1I
        const sdelI = Math.sqrt(Math.max(0, rI * rI * dI * dI - DI * DI))
        const dxC1 = (DI * dyI + sdyO * dxI * sdelI) / (dI * dI)
        const dxC2 = (DI * dyI - sdyO * dxI * sdelI) / (dI * dI)
        const dyC1 = (-DI * dxI + Math.abs(dyI) * sdelI) / (dI * dI)
        const dyC2 = (-DI * dxI - Math.abs(dyI) * sdelI) / (dI * dI)
        const v22 = Math.sqrt((x1I - dxC2) ** 2 + (y1I - dyC2) ** 2) - Math.sqrt((x1I - dxC1) ** 2 + (y1I - dyC1) ** 2)
        const dxC = (v22 > 0) ? dxC1 : dxC2
        const dyC = (v22 > 0) ? dyC1 : dyC2
        const xC = hc + (dxC * rw2 / rI)
        const yC = vc + (dyC * rh2 / rI)
        const ist0 = Math.atan2(dyC * rh2 / rI, dxC * rw2 / rI)
        const istAng0 = (ist0 > 0) ? ist0 : ist0 + rdAngVal3
        const isw1 = stAng - istAng0
        const iswAng0 = (isw1 > 0) ? isw1 : isw1 + rdAngVal3
        const istAng = istAng0 + iswAng0
        const iswAng = -iswAng0
        const p5 = Math.sqrt((xF - xC) ** 2 + (yF - yC) ** 2) / 2 - thh
        const xGp = (p5 > 0) ? xF : xG
        const yGp = (p5 > 0) ? yF : yG
        const xBp = (p5 > 0) ? xC : xB
        const yBp = (p5 > 0) ? yC : yB
        const en0 = Math.atan2((yF - vc), (xF - hc))
        const en2 = (en0 > 0) ? en0 : en0 + rdAngVal3
        const sw0 = en2 - stAng
        const swAng = (sw0 > 0) ? sw0 - rdAngVal3 : sw0
        const stAng0 = stAng + swAng
        const strtAng = stAng0 * 180 / Math.PI
        const endAngVal = stAng * 180 / Math.PI
        const stiAng = istAng * 180 / Math.PI
        const ediAng = stiAng + (iswAng * 180 / Math.PI)
        pathData = `M ${xE},${yE} L ${xD},${yD} ${shapeArc(w / 2, h / 2, rw2, rh2, stiAng, ediAng, false).replace('M', 'L')} L ${xBp},${yBp} L ${xA},${yA} L ${xGp},${yGp} L ${xF},${yF} ${shapeArc(w / 2, h / 2, rw1, rh1, strtAng, endAngVal, false).replace('M', 'L')} z`
      }
      break
    case 'leftRightCircularArrow':
    case 'chartPlus':
    case 'chartStar':
    case 'chartX':
    case 'cornerTabs':
    case 'flowChartOfflineStorage':
    case 'folderCorner':
    case 'funnel':
    case 'lineInv':
    case 'nonIsoscelesTrapezoid':
    case 'plaqueTabs':
    case 'squareTabs':
    case 'upDownArrowCallout':
      pathData = `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`
      break
    default:
      pathData = `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`
  }

  return pathData
}