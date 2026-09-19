import { getTextByPathList } from './utils'

export function shapeArc(cX, cY, rX, rY, stAng, endAng, isClose) {
  let dData
  let angle = stAng
  if (endAng >= stAng) {
    while (angle <= endAng) {
      const radians = angle * (Math.PI / 180)
      const x = cX + Math.cos(radians) * rX
      const y = cY + Math.sin(radians) * rY
      if (angle === stAng) {
        dData = ' M' + x + ' ' + y
      }
      dData += ' L' + x + ' ' + y
      angle++
    }
  } 
  else {
    while (angle > endAng) {
      const radians = angle * (Math.PI / 180)
      const x = cX + Math.cos(radians) * rX
      const y = cY + Math.sin(radians) * rY
      if (angle === stAng) {
        dData = ' M ' + x + ' ' + y
      }
      dData += ' L ' + x + ' ' + y
      angle--
    }
  }
  dData += (isClose ? ' z' : '')
  return dData
}

export function getCustomShapePath(custShapType, w, h) {
  const pathLstNode = getTextByPathList(custShapType, ['a:pathLst'])
  let pathNodes = getTextByPathList(pathLstNode, ['a:path'])

  if (Array.isArray(pathNodes)) pathNodes = pathNodes.shift()

  const maxX = parseInt(pathNodes['attrs']['w'])
  const maxY = parseInt(pathNodes['attrs']['h'])
  const cX = maxX === 0 ? 0 : (1 / maxX) * w
  const cY = maxY === 0 ? 0 : (1 / maxY) * h
  let d = ''

  let moveToNode = getTextByPathList(pathNodes, ['a:moveTo'])

  let lnToNodes = pathNodes['a:lnTo']
  let cubicBezToNodes = pathNodes['a:cubicBezTo']
  let quadBezToNodes = pathNodes['a:quadBezTo']
  const arcToNodes = pathNodes['a:arcTo']
  let closeNode = getTextByPathList(pathNodes, ['a:close'])
  if (!Array.isArray(moveToNode)) moveToNode = [moveToNode]

  const multiSapeAry = []
  if (moveToNode.length > 0) {
    Object.keys(moveToNode).forEach(key => {
      const moveToPtNode = moveToNode[key]['a:pt']
      if (moveToPtNode) {
        Object.keys(moveToPtNode).forEach(key => {
          const moveToNoPt = moveToPtNode[key]
          const spX = moveToNoPt['x']
          const spY = moveToNoPt['y']
          const order = moveToNoPt['order']
          multiSapeAry.push({
            type: 'movto',
            x: spX,
            y: spY,
            order,
          })
        })
      }
    })
    if (lnToNodes) {
      if (!Array.isArray(lnToNodes)) lnToNodes = [lnToNodes]
      Object.keys(lnToNodes).forEach(key => {
        const lnToPtNode = lnToNodes[key]['a:pt']
        if (lnToPtNode) {
          Object.keys(lnToPtNode).forEach(key => {
            const lnToNoPt = lnToPtNode[key]
            const ptX = lnToNoPt['x']
            const ptY = lnToNoPt['y']
            const order = lnToNoPt['order']
            multiSapeAry.push({
              type: 'lnto',
              x: ptX,
              y: ptY,
              order,
            })
          })
        }
      })
    }
    if (cubicBezToNodes) {
      const cubicBezToPtNodesAry = []
      if (!Array.isArray(cubicBezToNodes)) cubicBezToNodes = [cubicBezToNodes]
      Object.keys(cubicBezToNodes).forEach(key => {
        cubicBezToPtNodesAry.push(cubicBezToNodes[key]['a:pt'])
      })

      cubicBezToPtNodesAry.forEach(key => {
        const pts_ary = []
        key.forEach(pt => {
          const pt_obj = {
            x: pt['attrs']['x'],
            y: pt['attrs']['y'],
          }
          pts_ary.push(pt_obj)
        })
        const order = key[0]['attrs']['order']
        multiSapeAry.push({
          type: 'cubicBezTo',
          cubBzPt: pts_ary,
          order,
        })
      })
    }
    if (quadBezToNodes) {
      const quadBezToPtNodesAry = []
      if (!Array.isArray(quadBezToNodes)) quadBezToNodes = [quadBezToNodes]
      Object.keys(quadBezToNodes).forEach(key => {
        quadBezToPtNodesAry.push(quadBezToNodes[key]['a:pt'])
      })

      quadBezToPtNodesAry.forEach(key => {
        const pts_ary = []
        key.forEach(pt => {
          const pt_obj = {
            x: pt['attrs']['x'],
            y: pt['attrs']['y'],
          }
          pts_ary.push(pt_obj)
        })
        const order = key[0]['attrs']['order']
        multiSapeAry.push({
          type: 'quadBezTo',
          quadBzPt: pts_ary,
          order,
        })
      })
    }
    if (arcToNodes) {
      const arcToNodesAttrs = arcToNodes['attrs']
      const order = arcToNodesAttrs['order']
      const hR = arcToNodesAttrs['hR']
      const wR = arcToNodesAttrs['wR']
      const stAng = arcToNodesAttrs['stAng']
      const swAng = arcToNodesAttrs['swAng']
      let shftX = 0
      let shftY = 0
      const arcToPtNode = getTextByPathList(arcToNodes, ['a:pt', 'attrs'])
      if (arcToPtNode) {
        shftX = arcToPtNode['x']
        shftY = arcToPtNode['y']
      }
      multiSapeAry.push({
        type: 'arcTo',
        hR: hR,
        wR: wR,
        stAng: stAng,
        swAng: swAng,
        shftX: shftX,
        shftY: shftY,
        order,
      })
    }
    if (closeNode) {
      if (!Array.isArray(closeNode)) closeNode = [closeNode]
      Object.keys(closeNode).forEach(() => {
        multiSapeAry.push({
          type: 'close',
          order: Infinity,
        })
      })
    }

    multiSapeAry.sort((a, b) => a.order - b.order)

    let k = 0
    while (k < multiSapeAry.length) {
      if (multiSapeAry[k].type === 'movto') {
        const spX = parseInt(multiSapeAry[k].x) * cX
        const spY = parseInt(multiSapeAry[k].y) * cY
        d += ' M' + spX + ',' + spY
      } 
      else if (multiSapeAry[k].type === 'lnto') {
        const Lx = parseInt(multiSapeAry[k].x) * cX
        const Ly = parseInt(multiSapeAry[k].y) * cY
        d += ' L' + Lx + ',' + Ly
      } 
      else if (multiSapeAry[k].type === 'cubicBezTo') {
        const Cx1 = parseInt(multiSapeAry[k].cubBzPt[0].x) * cX
        const Cy1 = parseInt(multiSapeAry[k].cubBzPt[0].y) * cY
        const Cx2 = parseInt(multiSapeAry[k].cubBzPt[1].x) * cX
        const Cy2 = parseInt(multiSapeAry[k].cubBzPt[1].y) * cY
        const Cx3 = parseInt(multiSapeAry[k].cubBzPt[2].x) * cX
        const Cy3 = parseInt(multiSapeAry[k].cubBzPt[2].y) * cY
        d += ' C' + Cx1 + ',' + Cy1 + ' ' + Cx2 + ',' + Cy2 + ' ' + Cx3 + ',' + Cy3
      }
      else if (multiSapeAry[k].type === 'quadBezTo') {
        const Qx1 = parseInt(multiSapeAry[k].quadBzPt[0].x) * cX
        const Qy1 = parseInt(multiSapeAry[k].quadBzPt[0].y) * cY
        const Qx2 = parseInt(multiSapeAry[k].quadBzPt[1].x) * cX
        const Qy2 = parseInt(multiSapeAry[k].quadBzPt[1].y) * cY
        d += ' Q' + Qx1 + ',' + Qy1 + ' ' + Qx2 + ',' + Qy2
      }
      else if (multiSapeAry[k].type === 'arcTo') {
        const hR = parseInt(multiSapeAry[k].hR) * cX
        const wR = parseInt(multiSapeAry[k].wR) * cY
        const stAng = parseInt(multiSapeAry[k].stAng) / 60000
        const swAng = parseInt(multiSapeAry[k].swAng) / 60000
        const endAng = stAng + swAng
        d += shapeArc(wR, hR, wR, hR, stAng, endAng, false)
      }
      else if (multiSapeAry[k].type === 'close') d += 'z'
      k++
    }
  }

  return d
}

export function identifyShape(shapeData) {
  const pathLst = shapeData['a:pathLst']
  if (!pathLst || !pathLst['a:path']) return 'custom'

  const path = pathLst['a:path']
  const pathWidth = parseInt(path.attrs?.w) || 0
  const pathHeight = parseInt(path.attrs?.h) || 0

  const commands = extractPathCommands(path)
  
  if (commands.length === 0) return 'custom'

  const analysis = analyzePathCommands(commands, pathWidth, pathHeight)
  
  return matchShape(analysis)
}

function extractPathCommands(path) {
  const commands = []
  
  if (path['a:moveTo']) {
    const moveTo = path['a:moveTo']
    const pt = moveTo['a:pt']
    if (pt) {
      commands.push({
        type: 'moveTo',
        points: [{ x: parseInt(pt.attrs?.x) || 0, y: parseInt(pt.attrs?.y) || 0 }]
      })
    }
  }

  const lineToList = normalizeToArray(path['a:lnTo'])
  lineToList.forEach(lnTo => {
    const pt = lnTo['a:pt']
    if (pt) {
      commands.push({
        type: 'lineTo',
        points: [{ x: parseInt(pt.attrs?.x) || 0, y: parseInt(pt.attrs?.y) || 0 }]
      })
    }
  })

  const cubicList = normalizeToArray(path['a:cubicBezTo'])
  cubicList.forEach(cubic => {
    const pts = normalizeToArray(cubic['a:pt'])
    const points = pts.map(pt => ({
      x: parseInt(pt.attrs?.x) || 0,
      y: parseInt(pt.attrs?.y) || 0
    }))
    if (points.length === 3) {
      commands.push({ type: 'cubicBezTo', points })
    }
  })

  const arcList = normalizeToArray(path['a:arcTo'])
  arcList.forEach(arc => {
    commands.push({
      type: 'arcTo',
      wR: parseInt(arc.attrs?.wR) || 0,
      hR: parseInt(arc.attrs?.hR) || 0,
      stAng: parseInt(arc.attrs?.stAng) || 0,
      swAng: parseInt(arc.attrs?.swAng) || 0
    })
  })

  const quadList = normalizeToArray(path['a:quadBezTo'])
  quadList.forEach(quad => {
    const pts = normalizeToArray(quad['a:pt'])
    const points = pts.map(pt => ({
      x: parseInt(pt.attrs?.x) || 0,
      y: parseInt(pt.attrs?.y) || 0
    }))
    commands.push({ type: 'quadBezTo', points })
  })

  if (path['a:close']) {
    commands.push({ type: 'close' })
  }

  return commands
}

function normalizeToArray(value) {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function analyzePathCommands(commands, pathWidth, pathHeight) {
  const analysis = {
    lineCount: 0,
    curveCount: 0,
    arcCount: 0,
    isClosed: false,
    vertices: [],
    aspectRatio: pathHeight !== 0 ? pathWidth / pathHeight : 1,
    pathWidth,
    pathHeight,
    hasCurves: false,
    isCircular: false,
    commands
  }

  commands.forEach(cmd => {
    switch (cmd.type) {
      case 'moveTo':
        analysis.vertices.push(cmd.points[0])
        break
      case 'lineTo':
        analysis.lineCount++
        analysis.vertices.push(cmd.points[0])
        break
      case 'cubicBezTo':
        analysis.curveCount++
        analysis.hasCurves = true
        if (cmd.points.length === 3) {
          analysis.vertices.push(cmd.points[2])
        }
        break
      case 'quadBezTo':
        analysis.curveCount++
        analysis.hasCurves = true
        if (cmd.points.length >= 2) {
          analysis.vertices.push(cmd.points[cmd.points.length - 1])
        }
        break
      case 'arcTo':
        analysis.arcCount++
        analysis.hasCurves = true
        break
      case 'close':
        analysis.isClosed = true
        break
      default:
        break
    }
  })

  if (analysis.curveCount === 4 && analysis.lineCount === 0 && analysis.isClosed) {
    analysis.isCircular = checkIfCircular(commands, pathWidth, pathHeight)
  }

  return analysis
}

function checkIfCircular(commands, width, height) {
  const bezierCommands = commands.filter(c => c.type === 'cubicBezTo')
  if (bezierCommands.length !== 4) return false

  const endpoints = bezierCommands.map(cmd => cmd.points[2])
  
  const hasTop = endpoints.some(p => Math.abs(p.y) < height * 0.1)
  const hasBottom = endpoints.some(p => Math.abs(p.y - height) < height * 0.1)
  const hasLeft = endpoints.some(p => Math.abs(p.x) < width * 0.1)
  const hasRight = endpoints.some(p => Math.abs(p.x - width) < width * 0.1)

  return (hasTop || hasBottom) && (hasLeft || hasRight)
}

function matchShape(analysis) {
  const { 
    lineCount,
    curveCount,
    isClosed,
    vertices,
    hasCurves,
    isCircular,
    pathWidth,
    pathHeight,
  } = analysis

  if (isCircular) return 'ellipse'

  if (analysis.arcCount >= 2 && isClosed && lineCount === 0) return 'ellipse'

  if (!hasCurves && isClosed && vertices.length >= 3) return matchPolygon(vertices, pathWidth, pathHeight)

  if (lineCount === 4 && curveCount === 4 && isClosed) return 'roundRect'

  if (lineCount >= 3 && curveCount > 0 && curveCount <= lineCount && isClosed) {
    const baseShape = matchPolygonByLineCount(lineCount)
    if (baseShape !== 'custom') return baseShape === 'rectangle' ? 'roundRect' : baseShape
  }
  return 'custom'
}

function matchPolygon(vertices, width, height) {
  const uniqueVertices = removeDuplicateVertices(vertices)
  const vertexCount = uniqueVertices.length

  switch (vertexCount) {
    case 3:
      return 'triangle'
    case 4:
      return matchQuadrilateral(uniqueVertices, width, height)
    case 5:
      return 'pentagon'
    case 6:
      return 'hexagon'
    case 7:
      return 'heptagon'
    case 8:
      return 'octagon'
    default:
      if (vertexCount > 8) {
        return 'ellipse'
      }
      return 'custom'
  }
}

function removeDuplicateVertices(vertices) {
  const threshold = 100
  const unique = []
  
  vertices.forEach(v => {
    const isDuplicate = unique.some(u => 
      Math.abs(u.x - v.x) < threshold && Math.abs(u.y - v.y) < threshold
    )
    if (!isDuplicate) unique.push(v)
  })
  
  return unique
}

function matchQuadrilateral(vertices) {
  if (vertices.length !== 4) return 'custom'

  const edges = []
  for (let i = 0; i < 4; i++) {
    const p1 = vertices[i]
    const p2 = vertices[(i + 1) % 4]
    edges.push({
      dx: p2.x - p1.x,
      dy: p2.y - p1.y,
      length: Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2)
    })
  }

  if (isRectangle(edges)) return 'roundRect'
  if (isRhombus(edges)) return 'rhombus'
  if (isParallelogram(edges)) return 'parallelogram'
  if (isTrapezoid(edges)) return 'trapezoid'

  return 'custom'
}

function isRectangle(edges) {
  const tolerance = 0.1
  const edge02Similar = Math.abs(edges[0].length - edges[2].length) / Math.max(edges[0].length, edges[2].length) < tolerance
  const edge13Similar = Math.abs(edges[1].length - edges[3].length) / Math.max(edges[1].length, edges[3].length) < tolerance
  
  if (!edge02Similar || !edge13Similar) return false

  for (let i = 0; i < 4; i++) {
    const e1 = edges[i]
    const e2 = edges[(i + 1) % 4]
    const dotProduct = e1.dx * e2.dx + e1.dy * e2.dy
    const cosAngle = dotProduct / (e1.length * e2.length)
    if (Math.abs(cosAngle) > 0.1) return false
  }
  
  return true
}

function isRhombus(edges) {
  const tolerance = 0.1
  const avgLength = edges.reduce((sum, e) => sum + e.length, 0) / 4
  
  return edges.every(e => Math.abs(e.length - avgLength) / avgLength < tolerance)
}

function isParallelogram(edges) {
  const tolerance = 0.15
  
  const slope0 = edges[0].dx !== 0 ? edges[0].dy / edges[0].dx : Infinity
  const slope2 = edges[2].dx !== 0 ? edges[2].dy / edges[2].dx : Infinity
  const slope1 = edges[1].dx !== 0 ? edges[1].dy / edges[1].dx : Infinity
  const slope3 = edges[3].dx !== 0 ? edges[3].dy / edges[3].dx : Infinity

  const parallel02 = Math.abs(slope0 - slope2) < tolerance || 
                     (Math.abs(slope0) > 1000 && Math.abs(slope2) > 1000)
  const parallel13 = Math.abs(slope1 - slope3) < tolerance ||
                     (Math.abs(slope1) > 1000 && Math.abs(slope3) > 1000)

  return parallel02 && parallel13
}

function isTrapezoid(edges) {
  const tolerance = 0.15
  
  const slope0 = edges[0].dx !== 0 ? edges[0].dy / edges[0].dx : Infinity
  const slope2 = edges[2].dx !== 0 ? edges[2].dy / edges[2].dx : Infinity
  const slope1 = edges[1].dx !== 0 ? edges[1].dy / edges[1].dx : Infinity
  const slope3 = edges[3].dx !== 0 ? edges[3].dy / edges[3].dx : Infinity

  const parallel02 = Math.abs(slope0 - slope2) < tolerance ||
                     (Math.abs(slope0) > 1000 && Math.abs(slope2) > 1000)
  const parallel13 = Math.abs(slope1 - slope3) < tolerance ||
                     (Math.abs(slope1) > 1000 && Math.abs(slope3) > 1000)

  return (parallel02 && !parallel13) || (!parallel02 && parallel13)
}

function matchPolygonByLineCount(lineCount) {
  switch (lineCount) {
    case 3: return 'triangle'
    case 4: return 'rectangle'
    case 5: return 'pentagon'
    case 6: return 'hexagon'
    case 7: return 'heptagon'
    case 8: return 'octagon'
    default: return 'custom'
  }
}