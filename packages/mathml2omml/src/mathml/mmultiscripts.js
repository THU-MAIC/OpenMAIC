import { walker } from '../walker.js'

export function mmultiscripts(element, targetParent, previousSibling, nextSibling, ancestors) {
  if (element.children.length === 0) {
    // Don't use
    return
  }

  const base = element.children[0]
  const postSubs = []
  const postSupers = []
  const preSubs = []
  const preSupers = []
  const children = element.children.slice(1)
  let dividerFound = false
  children.forEach((child, index) => {
    if (child.name === 'mprescripts') {
      dividerFound = true
    } else if (child.name !== 'none') {
      if (index % 2) {
        if (dividerFound) {
          preSubs.push(child)
        } else {
          postSupers.push(child)
        }
      } else {
        if (dividerFound) {
          preSupers.push(child)
        } else {
          postSubs.push(child)
        }
      }
    }
  })
  ancestors = [...ancestors]
  ancestors.unshift(element)
  const tempTarget = {
    children: []
  }
  walker(base, tempTarget, false, false, ancestors)
  let topTarget = tempTarget.children[0]

  if (postSubs.length || postSupers.length) {
    const subscriptTarget = {
      name: 'm:sub',
      type: 'tag',
      attribs: {},
      children: []
    }
    postSubs.forEach((subscript) => walker(subscript, subscriptTarget, false, false, ancestors))

    const superscriptTarget = {
      name: 'm:sup',
      type: 'tag',
      attribs: {},
      children: []
    }

    postSupers.forEach((superscript) =>
      walker(superscript, superscriptTarget, false, false, ancestors)
    )

    const topPostTarget = {
      type: 'tag',
      attribs: {},
      children: [
        {
          type: 'tag',
          name: 'm:e',
          attribs: {},
          children: [topTarget]
        }
      ]
    }
    if (postSubs.length && postSupers.length) {
      topPostTarget.name = 'm:sSubSup'
      topPostTarget.children.push(subscriptTarget)
      topPostTarget.children.push(superscriptTarget)
    } else if (postSubs.length) {
      topPostTarget.name = 'm:sSub'
      topPostTarget.children.push(subscriptTarget)
    } else {
      topPostTarget.name = 'm:sSup'
      topPostTarget.children.push(superscriptTarget)
    }
    topTarget = topPostTarget
  }

  if (preSubs.length || preSupers.length) {
    const preSubscriptTarget = {
      name: 'm:sub',
      type: 'tag',
      attribs: {},
      children: []
    }
    preSubs.forEach((subscript) => walker(subscript, preSubscriptTarget, false, false, ancestors))

    const preSuperscriptTarget = {
      name: 'm:sup',
      type: 'tag',
      attribs: {},
      children: []
    }

    preSupers.forEach((superscript) =>
      walker(superscript, preSuperscriptTarget, false, false, ancestors)
    )
    const topPreTarget = {
      name: 'm:sPre',
      type: 'tag',
      attribs: {},
      children: [
        {
          name: 'm:e',
          type: 'tag',
          attribs: {},
          children: [topTarget]
        },
        preSubscriptTarget,
        preSuperscriptTarget
      ]
    }
    topTarget = topPreTarget
  }
  targetParent.children.push(topTarget)
  // Don't iterate over children in the usual way.
}
