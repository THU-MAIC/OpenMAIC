import { walker } from '../walker.js'

export function mfrac(element, targetParent, previousSibling, nextSibling, ancestors) {
  if (element.children.length !== 2) {
    // treat as mrow
    return targetParent
  }

  const numerator = element.children[0]
  const denumerator = element.children[1]
  const numeratorTarget = {
    name: 'm:num',
    type: 'tag',
    attribs: {},
    children: []
  }
  const denumeratorTarget = {
    name: 'm:den',
    type: 'tag',
    attribs: {},
    children: []
  }
  ancestors = [...ancestors]
  ancestors.unshift(element)
  walker(numerator, numeratorTarget, false, false, ancestors)
  walker(denumerator, denumeratorTarget, false, false, ancestors)
  const lt = element.attribs?.linethickness
  const fracType = (lt === '0' || lt === '0px' || lt === '0em' || lt === '0pt') ? 'noBar' : 'bar'
  targetParent.children.push({
    type: 'tag',
    name: 'm:f',
    attribs: {},
    children: [
      {
        type: 'tag',
        name: 'm:fPr',
        attribs: {},
        children: [
          {
            type: 'tag',
            name: 'm:type',
            attribs: {
              'm:val': fracType
            },
            children: []
          }
        ]
      },
      numeratorTarget,
      denumeratorTarget
    ]
  })
  // Don't iterate over children in the usual way.
}
