import { getShapeFill, getSolidFill } from './fill'
import { getTextByPathList } from './utils'
import { getBorder } from './border'

export function getTableBorders(node, warpObj) {
  const borders = {}
  if (node['a:bottom']) {
    const obj = {
      'p:spPr': {
        'a:ln': node['a:bottom']['a:ln']
      }
    }
    const border = getBorder(obj, undefined, warpObj)
    borders.bottom = border
  }
  if (node['a:top']) {
    const obj = {
      'p:spPr': {
        'a:ln': node['a:top']['a:ln']
      }
    }
    const border = getBorder(obj, undefined, warpObj)
    borders.top = border
  }
  if (node['a:right']) {
    const obj = {
      'p:spPr': {
        'a:ln': node['a:right']['a:ln']
      }
    }
    const border = getBorder(obj, undefined, warpObj)
    borders.right = border
  }
  if (node['a:left']) {
    const obj = {
      'p:spPr': {
        'a:ln': node['a:left']['a:ln']
      }
    }
    const border = getBorder(obj, undefined, warpObj)
    borders.left = border
  }
  return borders
}

export async function getTableCellParams(tcNode, thisTblStyle, cellSource, warpObj) {
  const rowSpan = getTextByPathList(tcNode, ['attrs', 'rowSpan'])
  const colSpan = getTextByPathList(tcNode, ['attrs', 'gridSpan'])
  const vMerge = getTextByPathList(tcNode, ['attrs', 'vMerge'])
  const hMerge = getTextByPathList(tcNode, ['attrs', 'hMerge'])
  let fillColor
  let fontColor
  let fontBold

  const getCelFill = getTextByPathList(tcNode, ['a:tcPr'])
  if (getCelFill) {
    const cellObj = { 'p:spPr': getCelFill }
    const fill = await getShapeFill(cellObj, warpObj, 'slide')

    if (fill && fill.type === 'color' && fill.value) {
      fillColor = fill.value 
    }
  }
  if (!fillColor) {
    let bgFillschemeClr
    if (cellSource) bgFillschemeClr = getTextByPathList(thisTblStyle, [cellSource, 'a:tcStyle', 'a:fill', 'a:solidFill'])
    if (bgFillschemeClr) {
      fillColor = getSolidFill(bgFillschemeClr, undefined, undefined, warpObj)
    }
  }

  let rowTxtStyl
  if (cellSource) rowTxtStyl = getTextByPathList(thisTblStyle, [cellSource, 'a:tcTxStyle'])
  if (rowTxtStyl) {
    fontColor = getSolidFill(rowTxtStyl, undefined, undefined, warpObj)
    if (getTextByPathList(rowTxtStyl, ['attrs', 'b']) === 'on') fontBold = true
  }

  let lin_bottm = getTextByPathList(tcNode, ['a:tcPr', 'a:lnB'])
  if (!lin_bottm) {
    if (cellSource) lin_bottm = getTextByPathList(thisTblStyle[cellSource], ['a:tcStyle', 'a:tcBdr', 'a:bottom', 'a:ln'])
    if (!lin_bottm) lin_bottm = getTextByPathList(thisTblStyle, ['a:wholeTbl', 'a:tcStyle', 'a:tcBdr', 'a:bottom', 'a:ln'])
  }
  let lin_top = getTextByPathList(tcNode, ['a:tcPr', 'a:lnT'])
  if (!lin_top) {
    if (cellSource) lin_top = getTextByPathList(thisTblStyle[cellSource], ['a:tcStyle', 'a:tcBdr', 'a:top', 'a:ln'])
    if (!lin_top) lin_top = getTextByPathList(thisTblStyle, ['a:wholeTbl', 'a:tcStyle', 'a:tcBdr', 'a:top', 'a:ln'])
  }
  let lin_left = getTextByPathList(tcNode, ['a:tcPr', 'a:lnL'])
  if (!lin_left) {
    if (cellSource) lin_left = getTextByPathList(thisTblStyle[cellSource], ['a:tcStyle', 'a:tcBdr', 'a:left', 'a:ln'])
    if (!lin_left) lin_left = getTextByPathList(thisTblStyle, ['a:wholeTbl', 'a:tcStyle', 'a:tcBdr', 'a:left', 'a:ln'])
  }
  let lin_right = getTextByPathList(tcNode, ['a:tcPr', 'a:lnR'])
  if (!lin_right) {
    if (cellSource) lin_right = getTextByPathList(thisTblStyle[cellSource], ['a:tcStyle', 'a:tcBdr', 'a:right', 'a:ln'])
    if (!lin_right) lin_right = getTextByPathList(thisTblStyle, ['a:wholeTbl', 'a:tcStyle', 'a:tcBdr', 'a:right', 'a:ln'])
  }

  const borders = {}
  if (lin_bottm) borders.bottom = getBorder(lin_bottm, undefined, warpObj)
  if (lin_top) borders.top = getBorder(lin_top, undefined, warpObj)
  if (lin_left) borders.left = getBorder(lin_left, undefined, warpObj)
  if (lin_right) borders.right = getBorder(lin_right, undefined, warpObj)

  return {
    fillColor,
    fontColor,
    fontBold,
    borders,
    rowSpan: rowSpan ? +rowSpan : undefined,
    colSpan: colSpan ? +colSpan : undefined,
    vMerge: vMerge ? +vMerge : undefined,
    hMerge: hMerge ? +hMerge : undefined,
  }
}

export function getTableRowParams(trNodes, i, tblStylAttrObj, thisTblStyle, warpObj) {
  let fillColor
  let fontColor
  let fontBold

  if (thisTblStyle && thisTblStyle['a:wholeTbl']) {
    const bgFillschemeClr = getTextByPathList(thisTblStyle, ['a:wholeTbl', 'a:tcStyle', 'a:fill', 'a:solidFill'])
    if (bgFillschemeClr) {
      const local_fillColor = getSolidFill(bgFillschemeClr, undefined, undefined, warpObj)
      if (local_fillColor) fillColor = local_fillColor
    }
    const rowTxtStyl = getTextByPathList(thisTblStyle, ['a:wholeTbl', 'a:tcTxStyle'])
    if (rowTxtStyl) {
      const local_fontColor = getSolidFill(rowTxtStyl, undefined, undefined, warpObj)
      if (local_fontColor) fontColor = local_fontColor
      if (getTextByPathList(rowTxtStyl, ['attrs', 'b']) === 'on') fontBold = true
    }
  }
  if (i === 0 && tblStylAttrObj['isFrstRowAttr'] === 1 && thisTblStyle) {
    const bgFillschemeClr = getTextByPathList(thisTblStyle, ['a:firstRow', 'a:tcStyle', 'a:fill', 'a:solidFill'])
    if (bgFillschemeClr) {
      const local_fillColor = getSolidFill(bgFillschemeClr, undefined, undefined, warpObj)
      if (local_fillColor) fillColor = local_fillColor
    }
    const rowTxtStyl = getTextByPathList(thisTblStyle, ['a:firstRow', 'a:tcTxStyle'])
    if (rowTxtStyl) {
      const local_fontColor = getSolidFill(rowTxtStyl, undefined, undefined, warpObj)
      if (local_fontColor) fontColor = local_fontColor
      if (getTextByPathList(rowTxtStyl, ['attrs', 'b']) === 'on') fontBold = true
    }
  }
  else if (i > 0 && tblStylAttrObj['isBandRowAttr'] === 1 && thisTblStyle) {
    fillColor = ''
    if ((i % 2) === 0 && thisTblStyle['a:band2H']) {
      const bgFillschemeClr = getTextByPathList(thisTblStyle, ['a:band2H', 'a:tcStyle', 'a:fill', 'a:solidFill'])
      if (bgFillschemeClr) {
        const local_fillColor = getSolidFill(bgFillschemeClr, undefined, undefined, warpObj)
        if (local_fillColor) fillColor = local_fillColor
      }
      const rowTxtStyl = getTextByPathList(thisTblStyle, ['a:band2H', 'a:tcTxStyle'])
      if (rowTxtStyl) {
        const local_fontColor = getSolidFill(rowTxtStyl, undefined, undefined, warpObj)
        if (local_fontColor) fontColor = local_fontColor
      }
      if (getTextByPathList(rowTxtStyl, ['attrs', 'b']) === 'on') fontBold = true
    }
    if ((i % 2) !== 0 && thisTblStyle['a:band1H']) {
      const bgFillschemeClr = getTextByPathList(thisTblStyle, ['a:band1H', 'a:tcStyle', 'a:fill', 'a:solidFill'])
      if (bgFillschemeClr) {
        const local_fillColor = getSolidFill(bgFillschemeClr, undefined, undefined, warpObj)
        if (local_fillColor) fillColor = local_fillColor
      }
      const rowTxtStyl = getTextByPathList(thisTblStyle, ['a:band1H', 'a:tcTxStyle'])
      if (rowTxtStyl) {
        const local_fontColor = getSolidFill(rowTxtStyl, undefined, undefined, warpObj)
        if (local_fontColor) fontColor = local_fontColor
        if (getTextByPathList(rowTxtStyl, ['attrs', 'b']) === 'on') fontBold = true
      }
    }
  }
  if (i === (trNodes.length - 1) && tblStylAttrObj['isLstRowAttr'] === 1 && thisTblStyle) {
    const bgFillschemeClr = getTextByPathList(thisTblStyle, ['a:lastRow', 'a:tcStyle', 'a:fill', 'a:solidFill'])
    if (bgFillschemeClr) {
      const local_fillColor = getSolidFill(bgFillschemeClr, undefined, undefined, warpObj)
      if (local_fillColor) {
        fillColor = local_fillColor
      }
    }
    const rowTxtStyl = getTextByPathList(thisTblStyle, ['a:lastRow', 'a:tcTxStyle'])
    if (rowTxtStyl) {
      const local_fontColor = getSolidFill(rowTxtStyl, undefined, undefined, warpObj)
      if (local_fontColor) fontColor = local_fontColor
      if (getTextByPathList(rowTxtStyl, ['attrs', 'b']) === 'on') fontBold = true
    }
  }

  return {
    fillColor,
    fontColor,
    fontBold,
  }
}