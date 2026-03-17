import { getTextContent } from '../helpers.js'

export function getStyle(element, ancestors, previousStyle = {}) {
  const elAttributes = element.attribs || {}
  const color =
    elAttributes.mathcolor ||
    ancestors.find(
      (element) => element.name === 'mstyle' && element.attribs && element.attribs.color
    )?.attribs.color ||
    ''
  // const minsize = parseFloat(elAttributes.scriptminsize || ancestors.find(element => element.name === 'mstyle' && element.attribs && element.attribs.scriptminsize)?.attribs.scriptminsize || '8pt')
  // const sizemultiplier = parseFloat(elAttributes.scriptsizemultiplier || ancestors.find(element => element.name === 'mstyle' && element.attribs && element.attribs.scriptsizemultiplier)?.attribs.scriptsizemultiplier || '0.71')
  const size =
    elAttributes.mathsize ||
    ancestors.find(
      (element) => element.name === 'mstyle' && element.attribs && element.attribs.mathsize
    )?.attribs.mathsize ||
    ''
  const scriptlevel =
    elAttributes.scriptlevel ||
    ancestors.find(
      (element) => element.name === 'mstyle' && element.attribs && element.attribs.scriptlevel
    )?.attribs.scriptlevel ||
    ''
  const background =
    elAttributes.mathbackground ||
    ancestors.find(
      (element) => element.name === 'mstyle' && element.attribs && element.attribs.mathbackground
    )?.attribs.mathbackground ||
    ''
  let variant =
    elAttributes.mathvariant ||
    ancestors.find(
      (element) => element.name === 'mstyle' && element.attribs && element.attribs.mathvariant
    )?.attribs.mathvariant ||
    ''
  if (variant === 'b-i') {
    variant = 'bold-italic'
  }
  const fontweight =
    elAttributes.fontweight ||
    ancestors.find(
      (element) => element.name === 'mstyle' && element.attribs && element.attribs.fontweight
    )?.attribs.fontweight ||
    ''
  if (fontweight === 'bold' && !['bold', 'bold-italic'].includes(variant)) {
    if (variant.includes('italic')) {
      variant = 'bold-italic'
    } else {
      variant = 'bold'
    }
  } else if (fontweight === 'normal' && ['bold', 'bold-italic'].includes(variant)) {
    if (variant.includes('italic')) {
      variant = 'italic'
    } else {
      variant = ''
    }
  }
  const fontstyle =
    elAttributes.fontstyle ||
    ancestors.find(
      (element) => element.name === 'mstyle' && element.attribs && element.attribs.fontstyle
    )?.attribs.fontstyle ||
    ''
  if (fontstyle === 'italic' && !['italic', 'bold-italic'].includes(variant)) {
    if (variant.includes('bold')) {
      variant = 'bold-italic'
    } else {
      variant = 'italic'
    }
  } else if (fontstyle === 'normal' && ['italic', 'bold-italic'].includes(variant)) {
    if (variant.includes('bold')) {
      variant = 'bold'
    } else {
      variant = ''
    }
  }
  // Override variant for some types
  if (!elAttributes.mathvariant) {
    const textContent = getTextContent(element)
    if (
      previousStyle.variant === '' &&
      ((element.name === 'mi' && textContent.length > 1) ||
        (element.name === 'mn' && !/^\d+\.\d+$/.test(textContent)))
    ) {
      variant = ''
    } else if (
      ['mi', 'mn', 'mo'].includes(element.name) &&
      ['italic', 'bold-italic'].includes(previousStyle.variant)
    ) {
      if (fontweight === 'bold') {
        variant = 'bold-italic'
      } else {
        variant = 'italic'
      }
    }
  }

  return {
    color,
    variant,
    size,
    scriptlevel,
    background,
    fontstyle
  }
}
