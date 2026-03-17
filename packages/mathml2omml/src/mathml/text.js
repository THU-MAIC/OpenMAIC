export function text(element, targetParent, previousSibling, nextSibling, ancestors) {
  let text = element.data.replace(/[\u2062]|[\u200B]/g, '')
  if (ancestors.find((element) => ['mi', 'mn', 'mo'].includes(element.name))) {
    text = text.replace(/\s/g, '')
  } else {
    const ms = ancestors.find((element) => element.name === 'ms')
    if (ms) {
      text = (ms.attribs?.lquote || '"') + text + (ms.attribs?.rquote || '"')
    }
  }
  if (text.length) {
    if (
      targetParent.children.length &&
      targetParent.children[targetParent.children.length - 1].type === 'text'
    ) {
      targetParent.children[targetParent.children.length - 1].data += text
    } else {
      targetParent.children.push({
        type: 'text',
        data: text
      })
    }
  }
  return targetParent
}
