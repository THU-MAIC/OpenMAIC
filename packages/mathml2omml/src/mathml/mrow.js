export function mrow(element, targetParent, previousSibling, nextSibling, ancestors) {
  // Detect fence pattern: <mo fence="true">OPEN ... <mo fence="true">CLOSE
  // Convert to OMML <m:d> delimiter (e.g. binomial, \left(\right))
  const children = element.children || []
  if (children.length >= 2) {
    const first = children[0]
    const last = children[children.length - 1]
    if (first?.name === 'mo' && first?.attribs?.fence === 'true' &&
        last?.name === 'mo' && last?.attribs?.fence === 'true') {
      const begChar = first.children?.[0]?.data || '('
      const endChar = last.children?.[0]?.data || ')'
      const dNode = {
        type: 'tag', name: 'm:d', attribs: {}, children: [
          { type: 'tag', name: 'm:dPr', attribs: {}, children: [
            { type: 'tag', name: 'm:begChr', attribs: { 'm:val': begChar }, children: [] },
            { type: 'tag', name: 'm:endChr', attribs: { 'm:val': endChar }, children: [] },
            { type: 'tag', name: 'm:ctrlPr', attribs: {}, children: [] }
          ]},
          { type: 'tag', name: 'm:e', attribs: {}, children: [] }
        ]
      }
      targetParent.children.push(dNode)
      // Mark fence operators so the walker child loop skips them
      first.skipInWalker = true
      last.skipInWalker = true
      // Return <m:e> as target — inner children go here
      return dNode.children[1]
    }
  }
  // isNary redirect is now handled in walker's child loop
  return targetParent
}
