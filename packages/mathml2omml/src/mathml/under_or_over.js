import { getNary, getNaryTarget } from '../ooml/index.js'
import { walker } from '../walker.js'

import { getTextContent } from '../helpers.js'

const UPPER_COMBINATION = {
  '\u2190': '\u20D6', // arrow left
  '\u27F5': '\u20D6', // arrow left, long
  '\u2192': '\u20D7', // arrow right
  '\u27F6': '\u20D7', // arrow right, long
  '\u00B4': '\u0301', // accute
  '\u02DD': '\u030B', // accute, double
  '\u02D8': '\u0306', // breve
  ˇ: '\u030C', // caron
  '\u00B8': '\u0312', // cedilla
  '\u005E': '\u0302', // circumflex accent
  '\u00A8': '\u0308', // diaresis
  '\u02D9': '\u0307', // dot above
  '\u0060': '\u0300', // grave accent
  '\u002D': '\u0305', // hyphen -> overline
  '\u00AF': '\u0305', // macron
  '\u2212': '\u0305', // minus -> overline
  '\u002E': '\u0307', // period -> dot above
  '\u007E': '\u0303', // tilde
  '\u02DC': '\u0303' // small tilde
}

function underOrOver(element, targetParent, previousSibling, nextSibling, ancestors, direction) {
  // Munder/Mover

  if (element.children.length !== 2) {
    // treat as mrow
    return targetParent
  }

  ancestors = [...ancestors]
  ancestors.unshift(element)

  const base = element.children[0]
  const script = element.children[1]

  // Munder/Mover can be translated to ooml in different ways.

  // First we check for m:nAry.
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
    const topTarget = getNaryTarget(
      naryChar,
      element,
      'undOvr',
      direction === 'over',
      direction === 'under'
    )
    element.isNary = true

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
    walker(
      script,
      direction === 'under' ? subscriptTarget : superscriptTarget,
      false,
      false,
      ancestors
    )
    topTarget.children.push(subscriptTarget)
    topTarget.children.push(superscriptTarget)
    topTarget.children.push({ type: 'tag', name: 'm:e', attribs: {}, children: [] })
    targetParent.children.push(topTarget)
    return
  }

  const scriptText = getTextContent(script)

  const baseTarget = {
    name: 'm:e',
    type: 'tag',
    attribs: {},
    children: []
  }
  walker(base, baseTarget, false, false, ancestors)

  //
  // m:bar
  //
  // Then we check whether it should be an m:bar.
  // This happens if:
  // 1. The script text is a single character that corresponds to
  //    \u0332/\u005F (underbar) or \u0305/\u00AF (overbar)
  // 2. The type of the script element is mo.
  if (
    (direction === 'under' && script.name === 'mo' && ['\u0332', '\u005F'].includes(scriptText)) ||
    (direction === 'over' && script.name === 'mo' && ['\u0305', '\u00AF'].includes(scriptText))
  ) {
    // m:bar
    targetParent.children.push({
      type: 'tag',
      name: 'm:bar',
      attribs: {},
      children: [
        {
          type: 'tag',
          name: 'm:barPr',
          attribs: {},
          children: [
            {
              type: 'tag',
              name: 'm:pos',
              attribs: {
                'm:val': direction === 'under' ? 'bot' : 'top'
              },
              children: []
            }
          ]
        },
        {
          type: 'tag',
          name: 'm:e',
          attribs: {},
          children: [
            {
              type: 'tag',
              name: direction === 'under' ? 'm:sSub' : 'm:sSup',
              attribs: {},
              children: [
                {
                  type: 'tag',
                  name: direction === 'under' ? 'm:sSubPr' : 'm:sSupPr',
                  attribs: {},
                  children: [{ type: 'tag', name: 'm:ctrlPr', attribs: {}, children: [] }]
                },
                baseTarget,
                { type: 'tag', name: 'm:sub', attribs: {}, children: [] }
              ]
            }
          ]
        }
      ]
    })
    return
  }

  // m:acc
  //
  // Next we try to see if it is an m:acc. This is the case if:
  // 1. The scriptText is 0-1 characters long.
  // 2. The script is an mo-element
  // 3. The accent is set.
  if (
    (direction === 'under' &&
      element.attribs?.accentunder?.toLowerCase() === 'true' &&
      script.name === 'mo' &&
      scriptText.length < 2) ||
    (direction === 'over' &&
      element.attribs?.accent?.toLowerCase() === 'true' &&
      script.name === 'mo' &&
      scriptText.length < 2)
  ) {
    // m:acc
    targetParent.children.push({
      type: 'tag',
      name: 'm:acc',
      attribs: {},
      children: [
        {
          type: 'tag',
          name: 'm:accPr',
          attribs: {},
          children: [
            {
              type: 'tag',
              name: 'm:chr',
              attribs: {
                'm:val': UPPER_COMBINATION[scriptText] || scriptText
              },
              children: []
            }
          ]
        },
        baseTarget
      ]
    })
    return
  }
  // m:groupChr
  //
  // Now we try m:groupChr. Conditions are:
  // 1. Base is an 'mrow' and script is an 'mo'.
  // 2. Script length is 1.
  // 3. No accent
  if (
    element.attribs?.accent?.toLowerCase() !== 'true' &&
    element.attribs?.accentunder?.toLowerCase() !== 'true' &&
    script.name === 'mo' &&
    base.name === 'mrow' &&
    scriptText.length === 1
  ) {
    targetParent.children.push({
      type: 'tag',
      name: 'm:groupChr',
      attribs: {},
      children: [
        {
          type: 'tag',
          name: 'm:groupChrPr',
          attribs: {},
          children: [
            {
              type: 'tag',
              name: 'm:chr',
              attribs: {
                'm:val': scriptText,
                'm:pos': direction === 'under' ? 'bot' : 'top'
              },
              children: []
            }
          ]
        },
        baseTarget
      ]
    })
    return
  }
  // Fallback: m:lim

  const scriptTarget = {
    name: 'm:lim',
    type: 'tag',
    attribs: {},
    children: []
  }

  walker(script, scriptTarget, false, false, ancestors)
  targetParent.children.push({
    type: 'tag',
    name: direction === 'under' ? 'm:limLow' : 'm:limUpp',
    attribs: {},
    children: [baseTarget, scriptTarget]
  })
  // Don't iterate over children in the usual way.
}

export function munder(element, targetParent, previousSibling, nextSibling, ancestors) {
  return underOrOver(element, targetParent, previousSibling, nextSibling, ancestors, 'under')
}

export function mover(element, targetParent, previousSibling, nextSibling, ancestors) {
  return underOrOver(element, targetParent, previousSibling, nextSibling, ancestors, 'over')
}
