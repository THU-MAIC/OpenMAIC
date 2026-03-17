import { getNary, getNaryTarget } from '../ooml/index.js'
import { walker } from '../walker.js'

export function msubsup(element, targetParent, previousSibling, nextSibling, ancestors) {
  // Sub + superscript
  if (element.children.length !== 3) {
    // treat as mrow
    return targetParent
  }

  ancestors = [...ancestors]
  ancestors.unshift(element)

  const base = element.children[0]
  const subscript = element.children[1]
  const superscript = element.children[2]

  let topTarget
  //
  // m:nAry
  //
  // Conditions:
  // 1. base text must be nary operator
  // 2. no accents
  const naryChar = getNary(base)
  if (
    naryChar &&
    element.attribs?.accent?.toLowerCase() !== 'true' &&
    element.attribs?.accentunder?.toLowerCase() !== 'true'
  ) {
    topTarget = getNaryTarget(naryChar, element, 'subSup')
    element.isNary = true
  } else {
    // Check for empty base → prescript pattern (LaTeX {}^{sup}_{sub}X)
    const isEmptyBase = base.name === 'mrow' && (!base.children || base.children.length === 0)

    if (isEmptyBase) {
      topTarget = {
        type: 'tag',
        name: 'm:sPre',
        attribs: {},
        children: [
          {
            type: 'tag',
            name: 'm:sPrePr',
            attribs: {},
            children: [
              {
                type: 'tag',
                name: 'm:ctrlPr',
                attribs: {},
                children: []
              }
            ]
          }
        ]
      }
      element.isPrescript = true
    } else {
      // Regular m:sSubSup
      const baseTarget = {
        name: 'm:e',
        type: 'tag',
        attribs: {},
        children: []
      }

      walker(base, baseTarget, false, false, ancestors)
      topTarget = {
        type: 'tag',
        name: 'm:sSubSup',
        attribs: {},
        children: [
          {
            type: 'tag',
            name: 'm:sSubSupPr',
            attribs: {},
            children: [
              {
                type: 'tag',
                name: 'm:ctrlPr',
                attribs: {},
                children: []
              }
            ]
          },
          baseTarget
        ]
      }
    }
  }

  const subscriptTarget = {
    name: 'm:sub',
    type: 'tag',
    attribs: {},
    children: []
  }
  const superscriptTarget = {
    name: 'm:sup',
    type: 'tag',
    attribs: {},
    children: []
  }
  walker(subscript, subscriptTarget, false, false, ancestors)
  walker(superscript, superscriptTarget, false, false, ancestors)
  topTarget.children.push(subscriptTarget)
  topTarget.children.push(superscriptTarget)
  if (element.isNary) {
    topTarget.children.push({ type: 'tag', name: 'm:e', attribs: {}, children: [] })
  }
  if (element.isPrescript) {
    topTarget.children.push({ type: 'tag', name: 'm:e', attribs: {}, children: [] })
  }
  targetParent.children.push(topTarget)
  // Don't iterate over children in the usual way.
}
