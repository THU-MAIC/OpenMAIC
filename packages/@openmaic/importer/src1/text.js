import { getHorizontalAlign, getParagraphSpacing } from './align'
import { getTextByPathList } from './utils'

import {
  getFontType,
  getFontColor,
  getFontSize,
  getFontBold,
  getFontItalic,
  getFontDecoration,
  getFontDecorationLine,
  getFontSpace,
  getFontSubscript,
  getFontShadow,
} from './fontStyle'

export function genTextBody(textBodyNode, spNode, slideLayoutSpNode, slideMasterSpNode, type, warpObj) {
  if (!textBodyNode) return ''

  let text = ''

  const pFontStyle = getTextByPathList(spNode, ['p:style', 'a:fontRef'])

  const pNode = textBodyNode['a:p']
  const pNodes = pNode.constructor === Array ? pNode : [pNode]

  const listTypes = []

  for (const pNode of pNodes) {
    let rNode = pNode['a:r']
    let fldNode = pNode['a:fld']
    let brNode = pNode['a:br']
    if (rNode) {
      rNode = (rNode.constructor === Array) ? rNode : [rNode]

      if (fldNode) {
        fldNode = (fldNode.constructor === Array) ? fldNode : [fldNode]
        rNode = rNode.concat(fldNode)
      }
      if (brNode) {
        brNode = (brNode.constructor === Array) ? brNode : [brNode]
        brNode.forEach(item => item.type = 'br')
  
        if (brNode.length > 1) brNode.shift()
        rNode = rNode.concat(brNode)
        rNode.sort((a, b) => {
          if (!a.attrs || !b.attrs) return true
          return a.attrs.order - b.attrs.order
        })
      }
    }

    const align = getHorizontalAlign(pNode, spNode, type, warpObj)
    const spacing = getParagraphSpacing(pNode)

    let styleText = `text-align: ${align};`
    if (spacing) {
      if (spacing.lineSpacing) styleText += `line-height: ${spacing.lineSpacing};`
      if (spacing.spaceBefore) styleText += `margin-top: ${spacing.spaceBefore};`
      if (spacing.spaceAfter) styleText += `margin-bottom: ${spacing.spaceAfter};`
    }

    const listType = getListType(pNode)
    const listLevel = getListLevel(pNode)

    if (listType) {
      while (listTypes.length > listLevel + 1) {
        const closedListType = listTypes.pop()
        text += `</${closedListType}>`
      }

      if (listTypes[listLevel] === undefined) {
        text += `<${listType}>`
        listTypes[listLevel] = listType
      }
      else if (listTypes[listLevel] !== listType) {
        text += `</${listTypes[listLevel]}>`
        text += `<${listType}>`
        listTypes[listLevel] = listType
      }
      text += `<li style="${styleText}">`
    }
    else {
      while (listTypes.length > 0) {
        const closedListType = listTypes.pop()
        text += `</${closedListType}>`
      }
      text += `<p style="${styleText}">`
    }
    
    if (!rNode) {
      text += genSpanElement(pNode, spNode, textBodyNode, pFontStyle, slideLayoutSpNode, slideMasterSpNode, type, warpObj)
    } 
    else {
      let prevStyleInfo = null
      let accumulatedText = ''

      for (const rNodeItem of rNode) {
        const styleInfo = getSpanStyleInfo(rNodeItem, pNode, textBodyNode, pFontStyle, slideLayoutSpNode, slideMasterSpNode, type, warpObj)

        if (!prevStyleInfo || prevStyleInfo.styleText !== styleInfo.styleText || prevStyleInfo.hasLink !== styleInfo.hasLink || styleInfo.hasLink) {
          if (accumulatedText) {
            const processedText = accumulatedText.replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;').replace(/\s/g, '&nbsp;')
            text += `<span style="${prevStyleInfo.styleText}">${processedText}</span>`
            accumulatedText = ''
          }

          if (styleInfo.hasLink) {
            const processedText = styleInfo.text.replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;').replace(/\s/g, '&nbsp;')
            text += `<span style="${styleInfo.styleText}"><a href="${styleInfo.linkURL}" target="_blank">${processedText}</a></span>`
            prevStyleInfo = null
          } 
          else {
            prevStyleInfo = styleInfo
            accumulatedText = styleInfo.text
          }
        } 
        else accumulatedText += styleInfo.text
      }

      if (accumulatedText && prevStyleInfo) {
        const processedText = accumulatedText.replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;').replace(/\s/g, '&nbsp;')
        text += `<span style="${prevStyleInfo.styleText}">${processedText}</span>`
      }
    }

    if (listType) text += '</li>'
    else text += '</p>'
  }
  while (listTypes.length > 0) {
    const closedListType = listTypes.pop()
    text += `</${closedListType}>`
  }
  return text
}

export function getListType(node) {
  const pPrNode = node['a:pPr']
  if (!pPrNode) return ''

  if (pPrNode['a:buChar']) return 'ul'
  if (pPrNode['a:buAutoNum']) return 'ol'
  
  return ''
}
export function getListLevel(node) {
  const pPrNode = node['a:pPr']
  if (!pPrNode) return -1

  const lvlNode = getTextByPathList(pPrNode, ['attrs', 'lvl'])
  if (lvlNode !== undefined) return parseInt(lvlNode)

  return 0
}

export function genSpanElement(node, pNode, textBodyNode, pFontStyle, slideLayoutSpNode, slideMasterSpNode, type, warpObj) {
  const { styleText, text, hasLink, linkURL } = getSpanStyleInfo(node, pNode, textBodyNode, pFontStyle, slideLayoutSpNode, slideMasterSpNode, type, warpObj)
  const processedText = text.replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;').replace(/\s/g, '&nbsp;')

  if (hasLink) {
    return `<span style="${styleText}"><a href="${linkURL}" target="_blank">${processedText}</a></span>`
  }
  return `<span style="${styleText}">${processedText}</span>`
}

export function getSpanStyleInfo(node, pNode, textBodyNode, pFontStyle, slideLayoutSpNode, slideMasterSpNode, type, warpObj) {
  const lstStyle = textBodyNode['a:lstStyle']
  const slideMasterTextStyles = warpObj['slideMasterTextStyles']

  let lvl = 1
  const pPrNode = pNode['a:pPr']
  const lvlNode = getTextByPathList(pPrNode, ['attrs', 'lvl'])
  if (lvlNode !== undefined) lvl = parseInt(lvlNode) + 1

  let text = node['a:t']
  if (typeof text !== 'string') text = getTextByPathList(node, ['a:fld', 'a:t'])
  if (typeof text !== 'string') text = '&nbsp;'

  let styleText = ''
  const fontColor = getFontColor(node, pNode, lstStyle, pFontStyle, lvl, warpObj)
  const fontSize = getFontSize(node, slideLayoutSpNode, type, slideMasterTextStyles, textBodyNode, pNode)
  const fontType = getFontType(node, type, warpObj, slideLayoutSpNode, slideMasterSpNode, slideMasterTextStyles)
  const fontBold = getFontBold(node)
  const fontItalic = getFontItalic(node)
  const fontDecoration = getFontDecoration(node)
  const fontDecorationLine = getFontDecorationLine(node)
  const fontSpace = getFontSpace(node)
  const shadow = getFontShadow(node, warpObj)
  const subscript = getFontSubscript(node)

  if (fontColor) {
    if (typeof fontColor === 'string') styleText += `color: ${fontColor};`
    else if (fontColor.colors) {
      const { colors, rot } = fontColor
      const stops = colors.map(item => `${item.color} ${item.pos}`).join(', ')
      const gradientStyle = `linear-gradient(${rot + 90}deg, ${stops})`
      styleText += `background: ${gradientStyle}; background-clip: text; color: transparent;`
    }
  }
  if (fontSize) styleText += `font-size: ${fontSize};`
  if (fontType) styleText += `font-family: ${fontType};`
  if (fontBold) styleText += `font-weight: ${fontBold};`
  if (fontItalic) styleText += `font-style: ${fontItalic};`
  if (fontDecoration) styleText += `text-decoration: ${fontDecoration};`
  if (fontDecorationLine) styleText += `text-decoration-line: ${fontDecorationLine};`
  if (fontSpace) styleText += `letter-spacing: ${fontSpace};`
  if (subscript) styleText += `vertical-align: ${subscript};`
  if (shadow) styleText += `text-shadow: ${shadow};`

  const linkID = getTextByPathList(node, ['a:rPr', 'a:hlinkClick', 'attrs', 'r:id'])
  const hasLink = linkID && warpObj['slideResObj'][linkID]

  return {
    styleText,
    text,
    hasLink,
    linkURL: hasLink ? warpObj['slideResObj'][linkID]['target'] : null
  }
}