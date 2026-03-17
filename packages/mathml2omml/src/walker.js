import * as mathmlHandlers from './mathml/index.js'
import { addScriptlevel } from './ooml/index.js'

export function walker(
  element,
  targetParent,
  previousSibling = false,
  nextSibling = false,
  ancestors = []
) {
  if (
    !previousSibling &&
    ['m:deg', 'm:den', 'm:e', 'm:fName', 'm:lim', 'm:num', 'm:sub', 'm:sup'].includes(
      targetParent.name
    )
  ) {
    // We are walking through the first element within one of the
    // elements where an <m:argPr> might occur. The <m:argPr> can specify
    // the scriptlevel, but it only makes sense if there is some content.
    // The fact that we are here means that there is at least one content item.
    // So we will check whether to add the m:rPr.
    // For possible parent types, see
    // https://docs.microsoft.com/en-us/dotnet/api/documentformat.openxml.math.argumentproperties?view=openxml-2.8.1#remarks
    addScriptlevel(targetParent, ancestors)
  }
  let targetElement
  const nameOrType = element.name || element.type
  if (mathmlHandlers[nameOrType]) {
    targetElement = mathmlHandlers[nameOrType](
      element,
      targetParent,
      previousSibling,
      nextSibling,
      ancestors
    )
  } else {
    if (nameOrType && nameOrType !== 'root') {
      console.warn(`Type not supported: ${nameOrType}`)
    }

    targetElement = targetParent
  }

  if (!targetElement) {
    // Target element hasn't been assigned, so don't handle children.
    return
  }
  if (element.children?.length) {
    ancestors = [...ancestors]
    ancestors.unshift(element)
    // Track nary body redirect: after a nary operator, redirect subsequent
    // siblings into its <m:e> until a relational operator (=, <, >, etc.) is
    // encountered.  Chains through nested nary operators (e.g. double
    // integrals ∫∫).
    let naryBodyTarget = null
    // Track prescript redirect: after a msubsup with empty base (e.g.
    // {}^{14}_{6}C), redirect the next sibling into <m:sPre>'s <m:e>.
    let prescriptTarget = null
    for (let i = 0; i < element.children.length; i++) {
      const child = element.children[i]
      if (child.skipInWalker) continue

      // A relational/separator <mo> or <mtext> stops the nary redirect so
      // that content after the operand stays outside the nary body.
      // Examples: ∑ aᵢ = S  →  operand is aᵢ  (stopped by =)
      //           ∑ aᵢ, bⱼ  →  operand is aᵢ  (stopped by ,)
      //           ∑ aᵢ \text{ for } i  →  operand is aᵢ  (stopped by mtext)
      if (naryBodyTarget) {
        if (child.name === 'mo') {
          const txt = child.children?.[0]?.data
          if (txt && /^[=<>≤≥≠≈≡∼≲≳≪≫∈∉⊂⊃⊆⊇⊄⊅≺≻⪯⪰∝≅≃≍≎∥⊥⊢⊣⊨⊩,;:∣]$/.test(txt)) {
            naryBodyTarget = null
          }
        } else if (child.name === 'mtext') {
          naryBodyTarget = null
        }
      }

      const effectiveTarget = prescriptTarget || naryBodyTarget || targetElement
      walker(
        child,
        effectiveTarget,
        element.children[i - 1],
        element.children[i + 1],
        ancestors
      )
      if (child.isNary) {
        // Chain into the new nary's <m:e>
        const naryNode = effectiveTarget.children[effectiveTarget.children.length - 1]
        naryBodyTarget = naryNode.children[naryNode.children.length - 1]
      }
      if (child.isPrescript) {
        // Redirect next sibling into <m:sPre>'s <m:e>
        const preNode = effectiveTarget.children[effectiveTarget.children.length - 1]
        prescriptTarget = preNode.children[preNode.children.length - 1]
      } else if (prescriptTarget) {
        // One element consumed; stop prescript redirect
        prescriptTarget = null
      }
    }
  }
}
