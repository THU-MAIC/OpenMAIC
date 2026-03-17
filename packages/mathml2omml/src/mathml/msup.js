import { getNary, getNaryTarget } from '../ooml/index.js'
import { walker } from '../walker.js'

export function msup(element, targetParent, previousSibling, nextSibling, ancestors) {
  // Superscript
  if (element.children.length !== 2) {
    // treat as mrow
    return targetParent
  }
  ancestors = [...ancestors]
  ancestors.unshift(element)
  const base = element.children[0]
  const superscript = element.children[1]

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
    topTarget = getNaryTarget(naryChar, element, 'subSup', true)
    element.isNary = true
    topTarget.children.push({ type: 'tag', name: 'm:sub' })
  } else {
    // Check for empty base → prescript pattern (LaTeX {}^{sup}X)
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
        name: 'm:sSup',
        attribs: {},
        children: [
          {
            type: 'tag',
            name: 'm:sSupPr',
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

  const superscriptTarget = {
    name: 'm:sup',
    type: 'tag',
    attribs: {},
    children: []
  }

  walker(superscript, superscriptTarget, false, false, ancestors)

  // For prescript, also add an empty m:sub
  if (element.isPrescript) {
    topTarget.children.push({ type: 'tag', name: 'm:sub', attribs: {}, children: [] })
  }
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
