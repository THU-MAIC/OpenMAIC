import { getNary, getNaryTarget } from '../ooml/index.js'
import { walker } from '../walker.js'

export function msub(element, targetParent, previousSibling, nextSibling, ancestors) {
  // Subscript
  if (element.children.length !== 2) {
    // treat as mrow
    return targetParent
  }
  ancestors = [...ancestors]
  ancestors.unshift(element)
  const base = element.children[0]
  const subscript = element.children[1]

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
    topTarget = getNaryTarget(naryChar, element, 'subSup', false, true)
    element.isNary = true
  } else {
    // Check for empty base → prescript pattern (LaTeX {}_{sub}X)
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
      const baseTarget = {
        name: 'm:e',
        type: 'tag',
        attribs: {},
        children: []
      }
      walker(base, baseTarget, false, false, ancestors)
      topTarget = {
        type: 'tag',
        name: 'm:sSub',
        attribs: {},
        children: [
          {
            type: 'tag',
            name: 'm:sSubPr',
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

  walker(subscript, subscriptTarget, false, false, ancestors)
  topTarget.children.push(subscriptTarget)
  if (element.isNary) {
    topTarget.children.push({ type: 'tag', name: 'm:sup', attribs: {}, children: [] })
    topTarget.children.push({ type: 'tag', name: 'm:e', attribs: {}, children: [] })
  }
  // For prescript, add empty m:sup and m:e (base filled by walker redirect)
  if (element.isPrescript) {
    topTarget.children.push({ type: 'tag', name: 'm:sup', attribs: {}, children: [] })
    topTarget.children.push({ type: 'tag', name: 'm:e', attribs: {}, children: [] })
  }
  targetParent.children.push(topTarget)
  // Don't iterate over children in the usual way.
}
