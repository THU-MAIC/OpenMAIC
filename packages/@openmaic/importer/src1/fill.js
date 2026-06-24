import tinycolor from 'tinycolor2'
import { getSchemeColorFromTheme } from './schemeColor'
import {
  applyShade,
  applyTint,
  applyLumOff,
  applyLumMod,
  applyHueMod,
  applySatMod,
  hslToRgb,
  getColorName2Hex,
} from './color'

import {
  base64ArrayBuffer,
  getTextByPathList,
  angleToDegrees,
  escapeHtml,
  getMimeType,
  toHex,
} from './utils'

export function getFillType(node) {
  let fillType = ''
  if (node['a:noFill']) fillType = 'NO_FILL'
  if (node['a:solidFill']) fillType = 'SOLID_FILL'
  if (node['a:gradFill']) fillType = 'GRADIENT_FILL'
  if (node['a:pattFill']) fillType = 'PATTERN_FILL'
  if (node['a:blipFill']) fillType = 'PIC_FILL'
  if (node['a:grpFill']) fillType = 'GROUP_FILL'

  return fillType
}

export async function getPicFill(type, node, warpObj) {
  if (!node) return ''

  let img
  const rId = getTextByPathList(node, ['a:blip', 'attrs', 'r:embed'])
  let imgPath
  if (type === 'slideBg' || type === 'slide') {
    imgPath = getTextByPathList(warpObj, ['slideResObj', rId, 'target'])
  }
  else if (type === 'slideLayoutBg') {
    imgPath = getTextByPathList(warpObj, ['layoutResObj', rId, 'target'])
  }
  else if (type === 'slideMasterBg') {
    imgPath = getTextByPathList(warpObj, ['masterResObj', rId, 'target'])
  }
  else if (type === 'themeBg') {
    imgPath = getTextByPathList(warpObj, ['themeResObj', rId, 'target'])
  }
  else if (type === 'diagramBg') {
    imgPath = getTextByPathList(warpObj, ['diagramResObj', rId, 'target'])
  }
  if (!imgPath) return imgPath

  img = getTextByPathList(warpObj, ['loaded-images', imgPath])
  if (!img) {
    imgPath = escapeHtml(imgPath)

    const imgExt = imgPath.split('.').pop()
    if (imgExt === 'xml') return ''

    const imgArrayBuffer = await warpObj['zip'].file(imgPath).async('arraybuffer')
    const imgMimeType = getMimeType(imgExt)
    if (warpObj.mediaMode === 'blob' && typeof URL !== 'undefined' && typeof Blob !== 'undefined' && URL.createObjectURL) {
      img = URL.createObjectURL(new Blob([imgArrayBuffer], { type: imgMimeType }))
    } else {
      img = `data:${imgMimeType};base64,${base64ArrayBuffer(imgArrayBuffer)}`
    }

    const loadedImages = warpObj['loaded-images'] || {}
    loadedImages[imgPath] = img
    warpObj['loaded-images'] = loadedImages
  }
  return img
}

export function getPicFillOpacity(node) {
  const aBlipNode = node['a:blip']

  const aphaModFixNode = getTextByPathList(aBlipNode, ['a:alphaModFix', 'attrs'])
  let opacity = 1
  if (aphaModFixNode && aphaModFixNode['amt'] && aphaModFixNode['amt'] !== '') {
    opacity = parseInt(aphaModFixNode['amt']) / 100000
  }

  return opacity
}

export function getPicFilters(node) {
  if (!node) return null

  const aBlipNode = node['a:blip']
  if (!aBlipNode) return null

  const filters = {}

  // 从a:extLst中获取滤镜效果（Microsoft Office 2010+扩展）
  const extLstNode = aBlipNode['a:extLst']
  if (extLstNode && extLstNode['a:ext']) {
    const extNodes = Array.isArray(extLstNode['a:ext']) ? extLstNode['a:ext'] : [extLstNode['a:ext']]

    for (const extNode of extNodes) {
      if (!extNode['a14:imgProps'] || !extNode['a14:imgProps']['a14:imgLayer']) continue

      const imgLayerNode = extNode['a14:imgProps']['a14:imgLayer']
      const imgEffects = imgLayerNode['a14:imgEffect']

      if (!imgEffects) continue

      const effectArray = Array.isArray(imgEffects) ? imgEffects : [imgEffects]

      for (const effect of effectArray) {
        // 饱和度
        if (effect['a14:saturation']) {
          const satAttr = getTextByPathList(effect, ['a14:saturation', 'attrs', 'sat'])
          if (satAttr) {
            filters.saturation = parseInt(satAttr) / 100000
          }
        }

        // 亮度、对比度
        if (effect['a14:brightnessContrast']) {
          const brightAttr = getTextByPathList(effect, ['a14:brightnessContrast', 'attrs', 'bright'])
          const contrastAttr = getTextByPathList(effect, ['a14:brightnessContrast', 'attrs', 'contrast'])

          if (brightAttr) {
            filters.brightness = parseInt(brightAttr) / 100000
          }
          if (contrastAttr) {
            filters.contrast = parseInt(contrastAttr) / 100000
          }
        }

        // 锐化/柔化
        if (effect['a14:sharpenSoften']) {
          const amountAttr = getTextByPathList(effect, ['a14:sharpenSoften', 'attrs', 'amount'])
          if (amountAttr) {
            const amount = parseInt(amountAttr) / 100000
            if (amount > 0) {
              filters.sharpen = amount
            }
            else {
              filters.soften = Math.abs(amount)
            }
          }
        }

        // 色温
        if (effect['a14:colorTemperature']) {
          const tempAttr = getTextByPathList(effect, ['a14:colorTemperature', 'attrs', 'colorTemp'])
          if (tempAttr) {
            filters.colorTemperature = parseInt(tempAttr)
          }
        }
      }
    }
  }

  return Object.keys(filters).length > 0 ? filters : null
}

export async function getBgPicFill(bgPr, sorce, warpObj) {
  const picBase64 = await getPicFill(sorce, bgPr['a:blipFill'], warpObj)
  const aBlipNode = bgPr['a:blipFill']['a:blip']

  const aphaModFixNode = getTextByPathList(aBlipNode, ['a:alphaModFix', 'attrs'])
  let opacity = 1
  if (aphaModFixNode && aphaModFixNode['amt'] && aphaModFixNode['amt'] !== '') {
    opacity = parseInt(aphaModFixNode['amt']) / 100000
  }

  return {
    picBase64,
    opacity,
  }
}

export function getGradientFill(node, warpObj) {
  const gsLst = node['a:gsLst']['a:gs']
  const colors = []
  for (let i = 0; i < gsLst.length; i++) {
    const lo_color = getSolidFill(gsLst[i], undefined, undefined, warpObj)
    const pos = getTextByPathList(gsLst[i], ['attrs', 'pos'])

    colors[i] = {
      pos: pos ? (pos / 1000 + '%') : '',
      color: lo_color,
    }
  }
  const lin = node['a:lin']
  let rot = 0
  let pathType = 'line'
  if (lin) rot = angleToDegrees(lin['attrs']['ang'])
  else {
    const path = node['a:path']
    if (path && path['attrs'] && path['attrs']['path']) pathType = path['attrs']['path']
  }
  return {
    rot,
    path: pathType,
    colors: colors.sort((a, b) => parseInt(a.pos) - parseInt(b.pos)),
  }
}

export function getPatternFill(node, warpObj) {
  if (!node) return null

  const pattFill = node['a:pattFill']
  if (!pattFill) return null

  const type = getTextByPathList(pattFill, ['attrs', 'prst'])

  const fgColorNode = pattFill['a:fgClr']
  const bgColorNode = pattFill['a:bgClr']

  let foregroundColor = '#000000'
  let backgroundColor = '#FFFFFF'

  if (fgColorNode) {
    foregroundColor = getSolidFill(fgColorNode, undefined, undefined, warpObj)
  }

  if (bgColorNode) {
    backgroundColor = getSolidFill(bgColorNode, undefined, undefined, warpObj)
  }

  return {
    type,
    foregroundColor,
    backgroundColor,
  }
}

export function getBgGradientFill(bgPr, phClr, slideMasterContent, warpObj) {
  if (bgPr) {
    const grdFill = bgPr['a:gradFill']
    const gsLst = grdFill['a:gsLst']['a:gs']
    const colors = []
    
    for (let i = 0; i < gsLst.length; i++) {
      const lo_color = getSolidFill(gsLst[i], slideMasterContent['p:sldMaster']['p:clrMap']['attrs'], phClr, warpObj)
      const pos = getTextByPathList(gsLst[i], ['attrs', 'pos'])

      colors[i] = {
        pos: pos ? (pos / 1000 + '%') : '',
        color: lo_color,
      }
    }
    const lin = grdFill['a:lin']
    let rot = 0
    let pathType = 'line'
    if (lin) rot = angleToDegrees(lin['attrs']['ang']) + 0
    else {
      const path = grdFill['a:path']
      if (path && path['attrs'] && path['attrs']['path']) pathType = path['attrs']['path'] 
    }
    return {
      rot,
      path: pathType,
      colors: colors.sort((a, b) => parseInt(a.pos) - parseInt(b.pos)),
    }
  }
  else if (phClr) {
    return phClr.indexOf('#') === -1 ? `#${phClr}` : phClr
  }
  return null
}

export async function getSlideBackgroundFill(warpObj) {
  const slideContent = warpObj['slideContent']
  const slideLayoutContent = warpObj['slideLayoutContent']
  const slideMasterContent = warpObj['slideMasterContent']
  
  let bgPr = getTextByPathList(slideContent, ['p:sld', 'p:cSld', 'p:bg', 'p:bgPr'])
  let bgRef = getTextByPathList(slideContent, ['p:sld', 'p:cSld', 'p:bg', 'p:bgRef'])

  let background = '#fff'
  let backgroundType = 'color'

  if (bgPr) {
    const bgFillTyp = getFillType(bgPr)

    if (bgFillTyp === 'SOLID_FILL') {
      const sldFill = bgPr['a:solidFill']
      let clrMapOvr
      const sldClrMapOvr = getTextByPathList(slideContent, ['p:sld', 'p:clrMapOvr', 'a:overrideClrMapping', 'attrs'])
      if (sldClrMapOvr) clrMapOvr = sldClrMapOvr
      else {
        const sldClrMapOvr = getTextByPathList(slideLayoutContent, ['p:sldLayout', 'p:clrMapOvr', 'a:overrideClrMapping', 'attrs'])
        if (sldClrMapOvr) clrMapOvr = sldClrMapOvr
        else clrMapOvr = getTextByPathList(slideMasterContent, ['p:sldMaster', 'p:clrMap', 'attrs'])
      }
      const sldBgClr = getSolidFill(sldFill, clrMapOvr, undefined, warpObj)
      background = sldBgClr
    }
    else if (bgFillTyp === 'GRADIENT_FILL') {
      const gradientFill = getBgGradientFill(bgPr, undefined, slideMasterContent, warpObj)
      if (typeof gradientFill === 'string') {
        background = gradientFill
      }
      else if (gradientFill) {
        background = gradientFill
        backgroundType = 'gradient'
      }
    }
    else if (bgFillTyp === 'PIC_FILL') {
      background = await getBgPicFill(bgPr, 'slideBg', warpObj)
      backgroundType = 'image'
    }
    else if (bgFillTyp === 'PATTERN_FILL') {
      const patternFill = getPatternFill(bgPr, warpObj)
      if (patternFill) {
        background = patternFill
        backgroundType = 'pattern'
      }
    }
  }
  else if (bgRef) {
    let clrMapOvr
    const sldClrMapOvr = getTextByPathList(slideContent, ['p:sld', 'p:clrMapOvr', 'a:overrideClrMapping', 'attrs'])
    if (sldClrMapOvr) clrMapOvr = sldClrMapOvr
    else {
      const sldClrMapOvr = getTextByPathList(slideLayoutContent, ['p:sldLayout', 'p:clrMapOvr', 'a:overrideClrMapping', 'attrs'])
      if (sldClrMapOvr) clrMapOvr = sldClrMapOvr
      else clrMapOvr = getTextByPathList(slideMasterContent, ['p:sldMaster', 'p:clrMap', 'attrs'])
    }
    const phClr = getSolidFill(bgRef, clrMapOvr, undefined, warpObj)
    const idx = Number(bgRef['attrs']['idx'])

    if (idx > 1000) {
      const trueIdx = idx - 1000
      const bgFillLst = warpObj['themeContent']['a:theme']['a:themeElements']['a:fmtScheme']['a:bgFillStyleLst']
      const sortblAry = []
      Object.keys(bgFillLst).forEach(key => {
        const bgFillLstTyp = bgFillLst[key]
        if (key !== 'attrs') {
          if (bgFillLstTyp.constructor === Array) {
            for (let i = 0; i < bgFillLstTyp.length; i++) {
              const obj = {}
              obj[key] = bgFillLstTyp[i]
              if (bgFillLstTyp[i]['attrs']) {
                obj['idex'] = bgFillLstTyp[i]['attrs']['order']
                obj['attrs'] = {
                  'order': bgFillLstTyp[i]['attrs']['order']
                }
              }
              sortblAry.push(obj)
            }
          } 
          else {
            const obj = {}
            obj[key] = bgFillLstTyp
            if (bgFillLstTyp['attrs']) {
              obj['idex'] = bgFillLstTyp['attrs']['order']
              obj['attrs'] = {
                'order': bgFillLstTyp['attrs']['order']
              }
            }
            sortblAry.push(obj)
          }
        }
      })
      const sortByOrder = sortblAry.slice(0)
      sortByOrder.sort((a, b) => a.idex - b.idex)
      const bgFillLstIdx = sortByOrder[trueIdx - 1]
      const bgFillTyp = getFillType(bgFillLstIdx)
      if (bgFillTyp === 'SOLID_FILL') {
        const sldFill = bgFillLstIdx['a:solidFill']
        const sldBgClr = getSolidFill(sldFill, clrMapOvr, undefined, warpObj)
        background = sldBgClr
      } 
      else if (bgFillTyp === 'GRADIENT_FILL') {
        const gradientFill = getBgGradientFill(bgFillLstIdx, phClr, slideMasterContent, warpObj)
        if (typeof gradientFill === 'string') {
          background = gradientFill
        }
        else if (gradientFill) {
          background = gradientFill
          backgroundType = 'gradient'
        }
      }
    }
  }
  else {
    bgPr = getTextByPathList(slideLayoutContent, ['p:sldLayout', 'p:cSld', 'p:bg', 'p:bgPr'])
    bgRef = getTextByPathList(slideLayoutContent, ['p:sldLayout', 'p:cSld', 'p:bg', 'p:bgRef'])

    let clrMapOvr
    const sldClrMapOvr = getTextByPathList(slideLayoutContent, ['p:sldLayout', 'p:clrMapOvr', 'a:overrideClrMapping', 'attrs'])
    if (sldClrMapOvr) clrMapOvr = sldClrMapOvr
    else clrMapOvr = getTextByPathList(slideMasterContent, ['p:sldMaster', 'p:clrMap', 'attrs'])

    if (bgPr) {
      const bgFillTyp = getFillType(bgPr)
      if (bgFillTyp === 'SOLID_FILL') {
        const sldFill = bgPr['a:solidFill']
        const sldBgClr = getSolidFill(sldFill, clrMapOvr, undefined, warpObj)
        background = sldBgClr
      }
      else if (bgFillTyp === 'GRADIENT_FILL') {
        const gradientFill = getBgGradientFill(bgPr, undefined, slideMasterContent, warpObj)
        if (typeof gradientFill === 'string') {
          background = gradientFill
        }
        else if (gradientFill) {
          background = gradientFill
          backgroundType = 'gradient'
        }
      }
      else if (bgFillTyp === 'PIC_FILL') {
        background = await getBgPicFill(bgPr, 'slideLayoutBg', warpObj)
        backgroundType = 'image'
      }
      else if (bgFillTyp === 'PATTERN_FILL') {
        const patternFill = getPatternFill(bgPr, warpObj)
        if (patternFill) {
          background = patternFill
          backgroundType = 'pattern'
        }
      }
    }
    else if (bgRef) {
      const phClr = getSolidFill(bgRef, clrMapOvr, undefined, warpObj)
      const idx = Number(bgRef['attrs']['idx'])
  
      if (idx > 1000) {
        const trueIdx = idx - 1000
        const bgFillLst = warpObj['themeContent']['a:theme']['a:themeElements']['a:fmtScheme']['a:bgFillStyleLst']
        const sortblAry = []
        Object.keys(bgFillLst).forEach(key => {
          const bgFillLstTyp = bgFillLst[key]
          if (key !== 'attrs') {
            if (bgFillLstTyp.constructor === Array) {
              for (let i = 0; i < bgFillLstTyp.length; i++) {
                const obj = {}
                obj[key] = bgFillLstTyp[i]
                if (bgFillLstTyp[i]['attrs']) {
                  obj['idex'] = bgFillLstTyp[i]['attrs']['order']
                  obj['attrs'] = {
                    'order': bgFillLstTyp[i]['attrs']['order']
                  }
                }
                sortblAry.push(obj)
              }
            } 
            else {
              const obj = {}
              obj[key] = bgFillLstTyp
              if (bgFillLstTyp['attrs']) {
                obj['idex'] = bgFillLstTyp['attrs']['order']
                obj['attrs'] = {
                  'order': bgFillLstTyp['attrs']['order']
                }
              }
              sortblAry.push(obj)
            }
          }
        })
        const sortByOrder = sortblAry.slice(0)
        sortByOrder.sort((a, b) => a.idex - b.idex)
        const bgFillLstIdx = sortByOrder[trueIdx - 1]
        const bgFillTyp = getFillType(bgFillLstIdx)
        if (bgFillTyp === 'SOLID_FILL') {
          const sldFill = bgFillLstIdx['a:solidFill']
          const sldBgClr = getSolidFill(sldFill, clrMapOvr, undefined, warpObj)
          background = sldBgClr
        }
        else if (bgFillTyp === 'GRADIENT_FILL') {
          const gradientFill = getBgGradientFill(bgFillLstIdx, phClr, slideMasterContent, warpObj)
          if (typeof gradientFill === 'string') {
            background = gradientFill
          }
          else if (gradientFill) {
            background = gradientFill
            backgroundType = 'gradient'
          }
        }
        else if (bgFillTyp === 'PIC_FILL') {
          background = await getBgPicFill(bgFillLstIdx, 'themeBg', warpObj)
          backgroundType = 'image'
        }
        else if (bgFillTyp === 'PATTERN_FILL') {
          const patternFill = getPatternFill(bgFillLstIdx, warpObj)
          if (patternFill) {
            background = patternFill
            backgroundType = 'pattern'
          }
        }
      }
    }
    else {
      bgPr = getTextByPathList(slideMasterContent, ['p:sldMaster', 'p:cSld', 'p:bg', 'p:bgPr'])
      bgRef = getTextByPathList(slideMasterContent, ['p:sldMaster', 'p:cSld', 'p:bg', 'p:bgRef'])

      const clrMap = getTextByPathList(slideMasterContent, ['p:sldMaster', 'p:clrMap', 'attrs'])
      if (bgPr) {
        const bgFillTyp = getFillType(bgPr)
        if (bgFillTyp === 'SOLID_FILL') {
          const sldFill = bgPr['a:solidFill']
          const sldBgClr = getSolidFill(sldFill, clrMap, undefined, warpObj)
          background = sldBgClr
        }
        else if (bgFillTyp === 'GRADIENT_FILL') {
          const gradientFill = getBgGradientFill(bgPr, undefined, slideMasterContent, warpObj)
          if (typeof gradientFill === 'string') {
            background = gradientFill
          }
          else if (gradientFill) {
            background = gradientFill
            backgroundType = 'gradient'
          }
        }
        else if (bgFillTyp === 'PIC_FILL') {
          background = await getBgPicFill(bgPr, 'slideMasterBg', warpObj)
          backgroundType = 'image'
        }
        else if (bgFillTyp === 'PATTERN_FILL') {
          const patternFill = getPatternFill(bgPr, warpObj)
          if (patternFill) {
            background = patternFill
            backgroundType = 'pattern'
          }
        }
      }
      else if (bgRef) {
        const phClr = getSolidFill(bgRef, clrMap, undefined, warpObj)
        const idx = Number(bgRef['attrs']['idx'])
    
        if (idx > 1000) {
          const trueIdx = idx - 1000
          const bgFillLst = warpObj['themeContent']['a:theme']['a:themeElements']['a:fmtScheme']['a:bgFillStyleLst']
          const sortblAry = []
          Object.keys(bgFillLst).forEach(key => {
            const bgFillLstTyp = bgFillLst[key]
            if (key !== 'attrs') {
              if (bgFillLstTyp.constructor === Array) {
                for (let i = 0; i < bgFillLstTyp.length; i++) {
                  const obj = {}
                  obj[key] = bgFillLstTyp[i]
                  if (bgFillLstTyp[i]['attrs']) {
                    obj['idex'] = bgFillLstTyp[i]['attrs']['order']
                    obj['attrs'] = {
                      'order': bgFillLstTyp[i]['attrs']['order']
                    }
                  }
                  sortblAry.push(obj)
                }
              } 
              else {
                const obj = {}
                obj[key] = bgFillLstTyp
                if (bgFillLstTyp['attrs']) {
                  obj['idex'] = bgFillLstTyp['attrs']['order']
                  obj['attrs'] = {
                    'order': bgFillLstTyp['attrs']['order']
                  }
                }
                sortblAry.push(obj)
              }
            }
          })
          const sortByOrder = sortblAry.slice(0)
          sortByOrder.sort((a, b) => a.idex - b.idex)
          const bgFillLstIdx = sortByOrder[trueIdx - 1]
          const bgFillTyp = getFillType(bgFillLstIdx)
          if (bgFillTyp === 'SOLID_FILL') {
            const sldFill = bgFillLstIdx['a:solidFill']
            const sldBgClr = getSolidFill(sldFill, clrMapOvr, undefined, warpObj)
            background = sldBgClr
          }
          else if (bgFillTyp === 'GRADIENT_FILL') {
            const gradientFill = getBgGradientFill(bgFillLstIdx, phClr, slideMasterContent, warpObj)
            if (typeof gradientFill === 'string') {
              background = gradientFill
            }
            else if (gradientFill) {
              background = gradientFill
              backgroundType = 'gradient'
            }
          }
          else if (bgFillTyp === 'PIC_FILL') {
            background = await getBgPicFill(bgFillLstIdx, 'themeBg', warpObj)
            backgroundType = 'image'
          }
          else if (bgFillTyp === 'PATTERN_FILL') {
            const patternFill = getPatternFill(bgFillLstIdx, warpObj)
            if (patternFill) {
              background = patternFill
              backgroundType = 'pattern'
            }
          }
        }
      }
    }
  }
  return {
    type: backgroundType,
    value: background,
  }
}

export async function getShapeFill(node, warpObj, source, groupHierarchy = []) {
  const fillType = getFillType(getTextByPathList(node, ['p:spPr']))
  let type = 'color'
  let fillValue = ''
  if (fillType === 'NO_FILL') {
    return null
  }
  else if (fillType === 'SOLID_FILL') {
    const shpFill = node['p:spPr']['a:solidFill']
    fillValue = getSolidFill(shpFill, undefined, undefined, warpObj)
    type = 'color'
  }
  else if (fillType === 'GRADIENT_FILL') {
    const shpFill = node['p:spPr']['a:gradFill']
    fillValue = getGradientFill(shpFill, warpObj)
    type = 'gradient'
  }
  else if (fillType === 'PIC_FILL') {
    const shpFill = node['p:spPr']['a:blipFill']
    const picBase64 = await getPicFill(source, shpFill, warpObj)
    const opacity = getPicFillOpacity(shpFill)
    fillValue = {
      picBase64,
      opacity,
    }
    type = 'image'
  }
  else if (fillType === 'PATTERN_FILL') {
    const shpFill = node['p:spPr']['a:pattFill']
    fillValue = getPatternFill({ 'a:pattFill': shpFill }, warpObj)
    type = 'pattern'
  }
  else if (fillType === 'GROUP_FILL') {
    return findFillInGroupHierarchy(groupHierarchy, warpObj, source)
  }
  if (!fillValue) {
    const clrName = getTextByPathList(node, ['p:style', 'a:fillRef'])
    fillValue = getSolidFill(clrName, undefined, undefined, warpObj)
    type = 'color'
  }
  if (!fillValue) {
    return null
  }

  return {
    type,
    value: fillValue,
  }
}

async function findFillInGroupHierarchy(groupHierarchy, warpObj, source) {
  for (const groupNode of groupHierarchy) {
    if (!groupNode || !groupNode['p:grpSpPr']) continue

    const grpSpPr = groupNode['p:grpSpPr']
    const fillType = getFillType(grpSpPr)

    if (fillType === 'SOLID_FILL') {
      const shpFill = grpSpPr['a:solidFill']
      const fillValue = getSolidFill(shpFill, undefined, undefined, warpObj)
      if (fillValue) {
        return {
          type: 'color',
          value: fillValue,
        }
      }
    }
    else if (fillType === 'GRADIENT_FILL') {
      const shpFill = grpSpPr['a:gradFill']
      const fillValue = getGradientFill(shpFill, warpObj)
      if (fillValue) {
        return {
          type: 'gradient',
          value: fillValue,
        }
      }
    }
    else if (fillType === 'PIC_FILL') {
      const shpFill = grpSpPr['a:blipFill']
      const picBase64 = await getPicFill(source, shpFill, warpObj)
      const opacity = getPicFillOpacity(shpFill)
      if (picBase64) {
        return {
          type: 'image',
          value: {
            picBase64,
            opacity,
          },
        }
      }
    }
    else if (fillType === 'PATTERN_FILL') {
      const shpFill = grpSpPr['a:pattFill']
      const fillValue = getPatternFill({ 'a:pattFill': shpFill }, warpObj)
      if (fillValue) {
        return {
          type: 'pattern',
          value: fillValue,
        }
      }
    }
  }

  return null
}

export function getSolidFill(solidFill, clrMap, phClr, warpObj) {
  if (!solidFill) return ''

  let color = ''
  let clrNode

  if (solidFill['a:srgbClr']) {
    clrNode = solidFill['a:srgbClr']
    color = getTextByPathList(clrNode, ['attrs', 'val'])
  } 
  else if (solidFill['a:schemeClr']) {
    clrNode = solidFill['a:schemeClr']
    const schemeClr = 'a:' + getTextByPathList(clrNode, ['attrs', 'val'])
    color = getSchemeColorFromTheme(schemeClr, warpObj, clrMap, phClr) || ''
  }
  else if (solidFill['a:scrgbClr']) {
    clrNode = solidFill['a:scrgbClr']
    const defBultColorVals = clrNode['attrs']
    const red = (defBultColorVals['r'].indexOf('%') !== -1) ? defBultColorVals['r'].split('%').shift() : defBultColorVals['r']
    const green = (defBultColorVals['g'].indexOf('%') !== -1) ? defBultColorVals['g'].split('%').shift() : defBultColorVals['g']
    const blue = (defBultColorVals['b'].indexOf('%') !== -1) ? defBultColorVals['b'].split('%').shift() : defBultColorVals['b']
    color = toHex(255 * (Number(red) / 100)) + toHex(255 * (Number(green) / 100)) + toHex(255 * (Number(blue) / 100))
  } 
  else if (solidFill['a:prstClr']) {
    clrNode = solidFill['a:prstClr']
    const prstClr = getTextByPathList(clrNode, ['attrs', 'val'])
    color = getColorName2Hex(prstClr)
  } 
  else if (solidFill['a:hslClr']) {
    clrNode = solidFill['a:hslClr']
    const defBultColorVals = clrNode['attrs']
    const hue = Number(defBultColorVals['hue']) / 100000
    const sat = Number((defBultColorVals['sat'].indexOf('%') !== -1) ? defBultColorVals['sat'].split('%').shift() : defBultColorVals['sat']) / 100
    const lum = Number((defBultColorVals['lum'].indexOf('%') !== -1) ? defBultColorVals['lum'].split('%').shift() : defBultColorVals['lum']) / 100
    const hsl2rgb = hslToRgb(hue, sat, lum)
    color = toHex(hsl2rgb.r) + toHex(hsl2rgb.g) + toHex(hsl2rgb.b)
  } 
  else if (solidFill['a:sysClr']) {
    clrNode = solidFill['a:sysClr']
    const sysClr = getTextByPathList(clrNode, ['attrs', 'lastClr'])
    if (sysClr) color = sysClr
  }

  let isAlpha = false
  const alpha = parseInt(getTextByPathList(clrNode, ['a:alpha', 'attrs', 'val'])) / 100000
  if (!isNaN(alpha)) {
    const al_color = tinycolor(color)
    al_color.setAlpha(alpha)
    color = al_color.toHex8()
    isAlpha = true
  }

  const hueMod = parseInt(getTextByPathList(clrNode, ['a:hueMod', 'attrs', 'val'])) / 100000
  if (!isNaN(hueMod)) {
    color = applyHueMod(color, hueMod, isAlpha)
  }
  const lumMod = parseInt(getTextByPathList(clrNode, ['a:lumMod', 'attrs', 'val'])) / 100000
  if (!isNaN(lumMod)) {
    color = applyLumMod(color, lumMod, isAlpha)
  }
  const lumOff = parseInt(getTextByPathList(clrNode, ['a:lumOff', 'attrs', 'val'])) / 100000
  if (!isNaN(lumOff)) {
    color = applyLumOff(color, lumOff, isAlpha)
  }
  const satMod = parseInt(getTextByPathList(clrNode, ['a:satMod', 'attrs', 'val'])) / 100000
  if (!isNaN(satMod)) {
    color = applySatMod(color, satMod, isAlpha)
  }
  const shade = parseInt(getTextByPathList(clrNode, ['a:shade', 'attrs', 'val'])) / 100000
  if (!isNaN(shade)) {
    color = applyShade(color, shade, isAlpha)
  }
  const tint = parseInt(getTextByPathList(clrNode, ['a:tint', 'attrs', 'val'])) / 100000
  if (!isNaN(tint)) {
    color = applyTint(color, tint, isAlpha)
  }

  if (color && color.indexOf('#') === -1) color = '#' + color

  return color
}