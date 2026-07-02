import { getTextByPathList } from './utils'
import { getShadow } from './shadow'
import { getFillType, getGradientFill, getSolidFill } from './fill'

export function getFontType(node, type, warpObj, slideLayoutSpNode, slideMasterSpNode, slideMasterTextStyles) {
  const extractFont = (targetNode, isDirectRun = false) => {
    if (!targetNode) return null
    
    let rPr
    if (isDirectRun) rPr = getTextByPathList(targetNode, ['a:rPr']) 
    else {
      rPr = getTextByPathList(targetNode, ['p:txBody', 'a:lstStyle', 'a:lvl1pPr', 'a:defRPr'])
      if (!rPr) rPr = getTextByPathList(targetNode, ['p:txBody', 'a:p', 'a:pPr', 'a:defRPr'])
    }

    if (!rPr) return null

    return getTextByPathList(rPr, ['a:latin', 'attrs', 'typeface']) || getTextByPathList(rPr, ['a:ea', 'attrs', 'typeface'])
  }

  let typeface = extractFont(node, true)

  if (!typeface) typeface = extractFont(slideLayoutSpNode)
  if (!typeface) typeface = extractFont(slideMasterSpNode)

  if (!typeface) {
    let stylePath = []
    if (type === 'title' || type === 'ctrTitle' || type === 'subTitle') {
      stylePath = ['p:titleStyle', 'a:lvl1pPr', 'a:defRPr']
    } 
    else if (type === 'body') {
      stylePath = ['p:bodyStyle', 'a:lvl1pPr', 'a:defRPr']
    } 
    else {
      stylePath = ['p:otherStyle', 'a:lvl1pPr', 'a:defRPr']
    }
    const masterGlobalRPr = getTextByPathList(slideMasterTextStyles, stylePath)
    if (masterGlobalRPr) {
      typeface = getTextByPathList(masterGlobalRPr, ['a:latin', 'attrs', 'typeface']) || getTextByPathList(masterGlobalRPr, ['a:ea', 'attrs', 'typeface'])
    }
  }

  if (!typeface || typeface.startsWith('+')) {
    const fontSchemeNode = getTextByPathList(warpObj['themeContent'], ['a:theme', 'a:themeElements', 'a:fontScheme'])

    if (fontSchemeNode) {
      if (typeface && typeface.startsWith('+')) {
        switch (typeface) {
          case '+mj-lt': 
            return getTextByPathList(fontSchemeNode, ['a:majorFont', 'a:latin', 'attrs', 'typeface'])
          case '+mn-lt': 
            return getTextByPathList(fontSchemeNode, ['a:minorFont', 'a:latin', 'attrs', 'typeface'])
          case '+mj-ea': 
            return getTextByPathList(fontSchemeNode, ['a:majorFont', 'a:ea', 'attrs', 'typeface'])
          case '+mn-ea': 
            return getTextByPathList(fontSchemeNode, ['a:minorFont', 'a:ea', 'attrs', 'typeface'])
          default: 
            return typeface.replace(/^\+/, '')
        }
      }
    }

    if (type === 'title' || type === 'subTitle' || type === 'ctrTitle') {
      typeface = getTextByPathList(fontSchemeNode, ['a:majorFont', 'a:latin', 'attrs', 'typeface']) || getTextByPathList(fontSchemeNode, ['a:majorFont', 'a:ea', 'attrs', 'typeface'])
    }
    else {
      typeface = getTextByPathList(fontSchemeNode, ['a:minorFont', 'a:latin', 'attrs', 'typeface'])
    }
  }

  return typeface || ''
}

export function getFontColor(node, pNode, lstStyle, pFontStyle, lvl, warpObj) {
  const rPrNode = getTextByPathList(node, ['a:rPr'])
  let filTyp, color
  if (rPrNode) {
    filTyp = getFillType(rPrNode)
    if (filTyp === 'SOLID_FILL') {
      const solidFillNode = rPrNode['a:solidFill']
      color = getSolidFill(solidFillNode, undefined, undefined, warpObj)
    }
    if (filTyp === 'GRADIENT_FILL') {
      const gradientFillNode = rPrNode['a:gradFill']
      const gradient = getGradientFill(gradientFillNode, warpObj)
      return gradient
    }
  }
  if (!color && getTextByPathList(lstStyle, ['a:lvl' + lvl + 'pPr', 'a:defRPr'])) {
    const lstStyledefRPr = getTextByPathList(lstStyle, ['a:lvl' + lvl + 'pPr', 'a:defRPr'])
    filTyp = getFillType(lstStyledefRPr)
    if (filTyp === 'SOLID_FILL') {
      const solidFillNode = lstStyledefRPr['a:solidFill']
      color = getSolidFill(solidFillNode, undefined, undefined, warpObj)
    }
  }
  if (!color) {
    const sPstyle = getTextByPathList(pNode, ['p:style', 'a:fontRef'])
    if (sPstyle) color = getSolidFill(sPstyle, undefined, undefined, warpObj)
    if (!color && pFontStyle) color = getSolidFill(pFontStyle, undefined, undefined, warpObj)
  }
  return color || ''
}

export function getFontSize(node, slideLayoutSpNode, type, slideMasterTextStyles, textBodyNode, pNode) {
  let fontSize

  if (getTextByPathList(node, ['a:rPr', 'attrs', 'sz'])) fontSize = getTextByPathList(node, ['a:rPr', 'attrs', 'sz']) / 100

  if ((isNaN(fontSize) || !fontSize) && pNode) {
    if (getTextByPathList(pNode, ['a:endParaRPr', 'attrs', 'sz'])) {
      fontSize = getTextByPathList(pNode, ['a:endParaRPr', 'attrs', 'sz']) / 100
    }
  }

  if ((isNaN(fontSize) || !fontSize) && textBodyNode) {
    const lstStyle = getTextByPathList(textBodyNode, ['a:lstStyle'])
    if (lstStyle) {
      let lvl = 1
      if (pNode) {
        const lvlNode = getTextByPathList(pNode, ['a:pPr', 'attrs', 'lvl'])
        if (lvlNode !== undefined) lvl = parseInt(lvlNode) + 1
      }

      const sz = getTextByPathList(lstStyle, [`a:lvl${lvl}pPr`, 'a:defRPr', 'attrs', 'sz'])
      if (sz) fontSize = parseInt(sz) / 100
    }
  }

  if ((isNaN(fontSize) || !fontSize)) {
    const sz = getTextByPathList(slideLayoutSpNode, ['p:txBody', 'a:lstStyle', 'a:lvl1pPr', 'a:defRPr', 'attrs', 'sz'])
    if (sz) fontSize = parseInt(sz) / 100
  }

  if ((isNaN(fontSize) || !fontSize) && slideLayoutSpNode) {
    let lvl = 1
    if (pNode) {
      const lvlNode = getTextByPathList(pNode, ['a:pPr', 'attrs', 'lvl'])
      if (lvlNode !== undefined) lvl = parseInt(lvlNode) + 1
    }
    const layoutSz = getTextByPathList(slideLayoutSpNode, ['p:txBody', 'a:lstStyle', `a:lvl${lvl}pPr`, 'a:defRPr', 'attrs', 'sz'])
    if (layoutSz) fontSize = parseInt(layoutSz) / 100
  }

  if ((isNaN(fontSize) || !fontSize) && pNode) {
    const paraSz = getTextByPathList(pNode, ['a:pPr', 'a:defRPr', 'attrs', 'sz'])
    if (paraSz) fontSize = parseInt(paraSz) / 100
  }

  if (isNaN(fontSize) || !fontSize) {
    let sz
    if (type === 'title' || type === 'subTitle' || type === 'ctrTitle') {
      sz = getTextByPathList(slideMasterTextStyles, ['p:titleStyle', 'a:lvl1pPr', 'a:defRPr', 'attrs', 'sz'])
    } 
    else if (type === 'body') {
      sz = getTextByPathList(slideMasterTextStyles, ['p:bodyStyle', 'a:lvl1pPr', 'a:defRPr', 'attrs', 'sz'])
    } 
    else if (type === 'dt' || type === 'sldNum') {
      sz = '1200'
    } 
    else if (!type) {
      sz = getTextByPathList(slideMasterTextStyles, ['p:otherStyle', 'a:lvl1pPr', 'a:defRPr', 'attrs', 'sz'])
    }
    if (sz) fontSize = parseInt(sz) / 100
  }

  const baseline = getTextByPathList(node, ['a:rPr', 'attrs', 'baseline'])
  if (baseline && !isNaN(fontSize)) fontSize -= 10

  fontSize = (isNaN(fontSize) || !fontSize) ? 18 : fontSize

  return fontSize + 'pt'
}

export function getFontBold(node) {
  return getTextByPathList(node, ['a:rPr', 'attrs', 'b']) === '1' ? 'bold' : ''
}

export function getFontItalic(node) {
  return getTextByPathList(node, ['a:rPr', 'attrs', 'i']) === '1' ? 'italic' : ''
}

export function getFontDecoration(node) {
  return getTextByPathList(node, ['a:rPr', 'attrs', 'u']) === 'sng' ? 'underline' : ''
}

export function getFontDecorationLine(node) {
  return getTextByPathList(node, ['a:rPr', 'attrs', 'strike']) === 'sngStrike' ? 'line-through' : ''
}

export function getFontSpace(node) {
  const spc = getTextByPathList(node, ['a:rPr', 'attrs', 'spc'])
  return spc ? (parseInt(spc) / 100 + 'pt') : ''
}

export function getFontSubscript(node) {
  const baseline = getTextByPathList(node, ['a:rPr', 'attrs', 'baseline'])
  if (!baseline) return ''
  return parseInt(baseline) > 0 ? 'super' : 'sub'
}

export function getFontShadow(node, warpObj) {
  const txtShadow = getTextByPathList(node, ['a:rPr', 'a:effectLst', 'a:outerShdw'])
  if (txtShadow) {
    const shadow = getShadow(txtShadow, warpObj)
    if (shadow) {
      const { h, v, blur, color } = shadow
      if (!isNaN(v) && !isNaN(h)) {
        return h + 'pt ' + v + 'pt ' + (blur ? blur + 'pt' : '') + ' ' + color
      }
    }
  }
  return ''
}