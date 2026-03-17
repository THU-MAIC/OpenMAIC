export function menclose(element, targetParent, previousSibling, nextSibling, ancestors) {
  const type = element.attribs?.notation?.split(' ')[0] || 'longdiv'

  const targetElement = {
    type: 'tag',
    name: 'm:e',
    attribs: {},
    children: []
  }

  if (type === 'longdiv') {
    targetParent.children.push({
      type: 'tag',
      name: 'm:rad',
      attribs: {},
      children: [
        {
          type: 'tag',
          name: 'm:radPr',
          attribs: {},
          children: [{ type: 'tag', name: 'm:degHide', attribs: { 'm:val': 'on' }, children: [] }]
        },
        { type: 'tag', name: 'm:deg', attribs: {}, children: [] },
        targetElement
      ]
    })
  } else {
    const hide = {
      t: { type: 'tag', name: 'm:hideTop', attribs: { 'm:val': 'on' }, children: [] },
      b: { type: 'tag', name: 'm:hideBot', attribs: { 'm:val': 'on' }, children: [] },
      l: { type: 'tag', name: 'm:hideLeft', attribs: { 'm:val': 'on' }, children: [] },
      r: { type: 'tag', name: 'm:hideRight', attribs: { 'm:val': 'on' }, children: [] }
    }
    const borderBoxPr = { type: 'tag', name: 'm:borderBoxPr', attribs: {}, children: [] }

    const containerElement = {
      type: 'tag',
      name: 'm:borderBox',
      attribs: {},
      children: []
    }
    switch (type) {
      case 'actuarial':
      case 'radical':
      case 'box':
        containerElement.children = [targetElement]
        break
      case 'left':
      case 'roundedbox':
        borderBoxPr.children = [hide.t, hide.b, hide.r]
        containerElement.children = [borderBoxPr, targetElement]
        break
      case 'right':
      case 'circle':
        borderBoxPr.children = [hide.t, hide.b, hide.l]
        containerElement.children = [borderBoxPr, targetElement]
        break
      case 'top':
        borderBoxPr.children = [hide.b, hide.l, hide.r]
        containerElement.children = [borderBoxPr, targetElement]
        break
      case 'bottom':
        borderBoxPr.children = [hide.t, hide.l, hide.r]
        containerElement.children = [borderBoxPr, targetElement]
        break
      case 'updiagonalstrike':
        borderBoxPr.children = [
          hide.t,
          hide.b,
          hide.l,
          hide.r,
          { type: 'tag', name: 'm:strikeBLTR', attribs: { 'm:val': 'on' }, children: [] }
        ]
        containerElement.children = [borderBoxPr, targetElement]
        break
      case 'downdiagonalstrike':
        borderBoxPr.children = [
          hide.t,
          hide.b,
          hide.l,
          hide.r,
          { type: 'tag', name: 'm:strikeTLBR', attribs: { 'm:val': 'on' }, children: [] }
        ]
        containerElement.children = [borderBoxPr, targetElement]
        break
      case 'verticalstrike':
        borderBoxPr.children = [
          hide.t,
          hide.b,
          hide.l,
          hide.r,
          { type: 'tag', name: 'm:strikeV', attribs: { 'm:val': 'on' }, children: [] }
        ]
        containerElement.children = [borderBoxPr, targetElement]
        break
      case 'horizontalstrike':
        borderBoxPr.children = [
          hide.t,
          hide.b,
          hide.l,
          hide.r,
          { type: 'tag', name: 'm:strikeH', attribs: { 'm:val': 'on' }, children: [] }
        ]
        containerElement.children = [borderBoxPr, targetElement]
        break
      default:
        borderBoxPr.children = [hide.t, hide.b, hide.l, hide.r]
        containerElement.children = [borderBoxPr, targetElement]
        break
    }
    targetParent.children.push(containerElement)
  }
  return targetElement
}
