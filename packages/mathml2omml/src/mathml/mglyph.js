export function mglyph(element, targetParent, previousSibling, nextSibling, ancestors) {
  // No support in omml. Output alt text.
  if (element.attribs?.alt) {
    targetParent.children.push({
      type: 'text',
      data: element.attribs.alt
    })
  }
}
