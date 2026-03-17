import { getStyle } from './text_style.js'

const STYLES = {
  bold: 'b',
  italic: 'i',
  'bold-italic': 'bi'
}

function textContainer(element, targetParent, previousSibling, nextSibling, ancestors, textType) {
  // isNary redirect is now handled in walker's child loop

  const hasMglyphChild = element.children?.find((element) => element.name === 'mglyph')
  const style = getStyle(element, ancestors, previousSibling?.style)
  element.style = style // Add it to element to make it comparable
  element.hasMglyphChild = hasMglyphChild
  const styleSame =
    Object.keys(style).every((key) => {
      const previousStyle = previousSibling?.style
      return previousStyle && style[key] === previousStyle[key]
    }) && previousSibling?.hasMglyphChild === hasMglyphChild
  const sameGroup = // Only group mtexts or mi, mn, mo with oneanother.
    textType === previousSibling?.name ||
    (['mi', 'mn', 'mo'].includes(textType) && ['mi', 'mn', 'mo'].includes(previousSibling?.name))
  let targetElement
  const lastChild = targetParent.children[targetParent.children.length - 1]
  if (sameGroup && styleSame && !hasMglyphChild && lastChild?.name === 'm:r') {
    targetElement = lastChild.children[lastChild.children.length - 1]
  } else {
    const rElement = {
      name: 'm:r',
      type: 'tag',
      attribs: {},
      children: []
    }

    if (style.variant) {
      const wrPr = {
        name: 'w:rPr',
        type: 'tag',
        attribs: {},
        children: []
      }
      if (style.variant.includes('bold')) {
        wrPr.children.push({ name: 'w:b', type: 'tag', attribs: {}, children: [] })
      }
      if (style.variant.includes('italic')) {
        wrPr.children.push({ name: 'w:i', type: 'tag', attribs: {}, children: [] })
      }
      rElement.children.push(wrPr)
      const mrPr = {
        name: 'm:rPr',
        type: 'tag',
        attribs: {},
        children: [
          {
            name: 'm:nor',
            type: 'tag',
            attribs: {},
            children: []
          }
        ]
      }
      if (style.variant !== 'italic') {
        mrPr.children.push({
          name: 'm:sty',
          type: 'tag',
          attribs: {
            'm:val': STYLES[style.variant]
          },
          children: []
        })
      }
      rElement.children.push(mrPr)
    } else if (hasMglyphChild || textType === 'mtext') {
      rElement.children.push({
        name: 'm:rPr',
        type: 'tag',
        attribs: {},
        children: [
          {
            name: 'm:nor',
            type: 'tag',
            attribs: {},
            children: []
          }
        ]
      })
    } else if (style.fontstyle === 'normal' || (textType === 'ms' && style.fontstyle === '')) {
      rElement.children.push({
        name: 'm:rPr',
        type: 'tag',
        attribs: {},
        children: [
          {
            name: 'm:sty',
            type: 'tag',
            attribs: { 'm:val': 'p' },
            children: []
          }
        ]
      })
    }

    targetElement = {
      name: 'm:t',
      type: 'tag',
      attribs: {
        'xml:space': 'preserve'
      },
      children: []
    }
    rElement.children.push(targetElement)
    targetParent.children.push(rElement)
  }
  return targetElement
}

export function mtext(element, targetParent, previousSibling, nextSibling, ancestors) {
  return textContainer(element, targetParent, previousSibling, nextSibling, ancestors, 'mtext')
}

export function mi(element, targetParent, previousSibling, nextSibling, ancestors) {
  return textContainer(element, targetParent, previousSibling, nextSibling, ancestors, 'mi')
}

export function mn(element, targetParent, previousSibling, nextSibling, ancestors) {
  return textContainer(element, targetParent, previousSibling, nextSibling, ancestors, 'mn')
}

export function mo(element, targetParent, previousSibling, nextSibling, ancestors) {
  return textContainer(element, targetParent, previousSibling, nextSibling, ancestors, 'mo')
}

export function ms(element, targetParent, previousSibling, nextSibling, ancestors) {
  return textContainer(element, targetParent, previousSibling, nextSibling, ancestors, 'ms')
}
