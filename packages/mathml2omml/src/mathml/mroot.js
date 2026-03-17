import { getTextContent } from '../helpers.js'
import { walker } from '../walker.js'

export function mroot(element, targetParent, previousSibling, nextSibling, ancestors) {
  // Root
  if (element.children.length !== 2) {
    // treat as mrow
    return targetParent
  }
  ancestors = [...ancestors]
  ancestors.unshift(element)
  const base = element.children[0]
  const root = element.children[1]

  const baseTarget = {
    type: 'tag',
    name: 'm:e',
    attribs: {},
    children: []
  }
  walker(base, baseTarget, false, false, ancestors)

  const rootTarget = {
    type: 'tag',
    name: 'm:deg',
    attribs: {},
    children: []
  }
  walker(root, rootTarget, false, false, ancestors)

  const rootText = getTextContent(root)

  targetParent.children.push({
    type: 'tag',
    name: 'm:rad',
    attribs: {},
    children: [
      {
        type: 'tag',
        name: 'm:radPr',
        attribs: {},
        children: [
          {
            type: 'tag',
            name: 'm:degHide',
            attribs: { 'm:val': rootText.length ? 'off' : 'on' },
            children: []
          }
        ]
      },
      rootTarget,
      baseTarget
    ]
  })
}
