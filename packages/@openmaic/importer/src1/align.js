import { getTextByPathList } from './utils'

export function getHorizontalAlign(node, pNode, type, warpObj) {
  let algn = getTextByPathList(node, ['a:pPr', 'attrs', 'algn'])
  if (!algn) algn = getTextByPathList(pNode, ['a:pPr', 'attrs', 'algn'])

  if (!algn) {
    if (type === 'title' || type === 'ctrTitle' || type === 'subTitle') {
      let lvlIdx = 1
      const lvlNode = getTextByPathList(pNode, ['a:pPr', 'attrs', 'lvl'])
      if (lvlNode) {
        lvlIdx = parseInt(lvlNode) + 1
      }
      const lvlStr = 'a:lvl' + lvlIdx + 'pPr'
      algn = getTextByPathList(warpObj, ['slideLayoutTables', 'typeTable', type, 'p:txBody', 'a:lstStyle', lvlStr, 'attrs', 'algn'])
      if (!algn) algn = getTextByPathList(warpObj, ['slideMasterTables', 'typeTable', type, 'p:txBody', 'a:lstStyle', lvlStr, 'attrs', 'algn'])
      if (!algn) algn = getTextByPathList(warpObj, ['slideMasterTextStyles', 'p:titleStyle', lvlStr, 'attrs', 'algn'])
      if (!algn && type === 'subTitle') {
        algn = getTextByPathList(warpObj, ['slideMasterTextStyles', 'p:bodyStyle', lvlStr, 'attrs', 'algn'])
      }
    } 
    else if (type === 'body') {
      algn = getTextByPathList(warpObj, ['slideMasterTextStyles', 'p:bodyStyle', 'a:lvl1pPr', 'attrs', 'algn'])
    } 
    else {
      algn = getTextByPathList(warpObj, ['slideMasterTables', 'typeTable', type, 'p:txBody', 'a:lstStyle', 'a:lvl1pPr', 'attrs', 'algn'])
    }
  }

  let align = 'left'
  if (algn) {
    switch (algn) {
      case 'l':
        align = 'left'
        break
      case 'r':
        align = 'right'
        break
      case 'ctr':
        align = 'center'
        break
      case 'just':
        align = 'justify'
        break
      case 'dist':
        align = 'justify'
        break
      default:
        align = 'inherit'
    }
  }
  return align
}

export function getVerticalAlign(node, slideLayoutSpNode, slideMasterSpNode) {
  let anchor = getTextByPathList(node, ['p:txBody', 'a:bodyPr', 'attrs', 'anchor'])
  if (!anchor) {
    anchor = getTextByPathList(slideLayoutSpNode, ['p:txBody', 'a:bodyPr', 'attrs', 'anchor'])
    if (!anchor) {
      anchor = getTextByPathList(slideMasterSpNode, ['p:txBody', 'a:bodyPr', 'attrs', 'anchor'])
      if (!anchor) anchor = 't'
    }
  }
  return (anchor === 'ctr') ? 'mid' : ((anchor === 'b') ? 'down' : 'up')
}

export function getTextAutoFit(node, slideLayoutSpNode, slideMasterSpNode) {
  function checkBodyPr(bodyPr) {
    if (!bodyPr) return null

    if (bodyPr['a:noAutofit']) return { result: null }
    else if (bodyPr['a:spAutoFit']) return { result: { type: 'shape' } }
    else if (bodyPr['a:normAutofit']) {
      const fontScale = getTextByPathList(bodyPr['a:normAutofit'], ['attrs', 'fontScale'])
      if (fontScale) {
        const scalePercent = parseInt(fontScale) / 1000
        return {
          result: {
            type: 'text',
            fontScale: scalePercent,
          }
        }
      }
      return { result: { type: 'text' } }
    }
    return null
  }

  const nodeCheck = checkBodyPr(getTextByPathList(node, ['p:txBody', 'a:bodyPr']))
  if (nodeCheck) return nodeCheck.result

  const layoutCheck = checkBodyPr(getTextByPathList(slideLayoutSpNode, ['p:txBody', 'a:bodyPr']))
  if (layoutCheck) return layoutCheck.result

  const masterCheck = checkBodyPr(getTextByPathList(slideMasterSpNode, ['p:txBody', 'a:bodyPr']))
  if (masterCheck) return masterCheck.result

  return null
}

export function getParagraphSpacing(pNode) {
  if (!pNode) return null

  const pPrNode = pNode['a:pPr']
  if (!pPrNode) return null

  const spacing = {}

  const lnSpcNode = pPrNode['a:lnSpc']
  if (lnSpcNode) {
    const spcPct = getTextByPathList(lnSpcNode, ['a:spcPct', 'attrs', 'val'])
    const spcPts = getTextByPathList(lnSpcNode, ['a:spcPts', 'attrs', 'val'])

    if (spcPct) {
      spacing.lineSpacing = parseInt(spcPct) / 1000 / 100
    } 
    else if (spcPts) {
      spacing.lineSpacing = parseInt(spcPts) / 100 + 'pt'
    }
  }

  const spcBefNode = pPrNode['a:spcBef']
  if (spcBefNode) {
    const spcPct = getTextByPathList(spcBefNode, ['a:spcPct', 'attrs', 'val'])
    const spcPts = getTextByPathList(spcBefNode, ['a:spcPts', 'attrs', 'val'])

    if (spcPct) {
      spacing.spaceBefore = parseInt(spcPct) / 1000 + 'em'
    } 
    else if (spcPts) {
      spacing.spaceBefore = parseInt(spcPts) / 100 + 'pt'
    }
  }

  const spcAftNode = pPrNode['a:spcAft']
  if (spcAftNode) {
    const spcPct = getTextByPathList(spcAftNode, ['a:spcPct', 'attrs', 'val'])
    const spcPts = getTextByPathList(spcAftNode, ['a:spcPts', 'attrs', 'val'])

    if (spcPct) {
      spacing.spaceAfter = parseInt(spcPct) / 1000 + 'em'
    } 
    else if (spcPts) {
      spacing.spaceAfter = parseInt(spcPts) / 100 + 'pt'
    }
  }

  return Object.keys(spacing).length > 0 ? spacing : null
}