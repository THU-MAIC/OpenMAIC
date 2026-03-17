export function math(element, targetParent, previousSibling, nextSibling, ancestors) {
  targetParent.name = 'm:oMath'
  targetParent.attribs = {
    'xmlns:m': 'http://schemas.openxmlformats.org/officeDocument/2006/math',
    'xmlns:w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
  }
  targetParent.type = 'tag'
  targetParent.children = []
  return targetParent
}

export function semantics(element, targetParent, previousSibling, nextSibling, ancestors) {
  // Ignore as default behavior
  return targetParent
}
