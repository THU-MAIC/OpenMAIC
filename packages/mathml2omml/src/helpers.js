export function getTextContent(node, trim = true) {
  let returnString = ''
  if (node.type === 'text') {
    let text = node.data.replace(/[\u2062]|[\u200B]/g, '')
    if (trim) {
      text = text.trim()
    }
    returnString += text
  } else if (node.children) {
    node.children.forEach((subNode) => {
      returnString += getTextContent(subNode, trim)
    })
  }
  return returnString
}
