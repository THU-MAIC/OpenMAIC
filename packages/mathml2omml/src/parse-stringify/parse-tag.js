const attrRE = /\s([^'"/\s><]+?)[\s/>]|([^\s=]+)=\s?(".*?"|'.*?')/g

export default function stringify(tag) {
  const res = {
    type: 'tag',
    name: '',
    voidElement: false,
    attribs: {},
    children: []
  }

  const tagMatch = tag.match(/<\/?([^\s]+?)[/\s>]/)
  if (tagMatch) {
    res.name = tagMatch[1]
    if (tag.charAt(tag.length - 2) === '/') {
      res.voidElement = true
    }

    // handle comment tag
    if (res.name.startsWith('!--')) {
      const endIndex = tag.indexOf('-->')
      return {
        type: 'comment',
        comment: endIndex !== -1 ? tag.slice(4, endIndex) : ''
      }
    }
  }

  const reg = new RegExp(attrRE)
  let result = null
  for (;;) {
    result = reg.exec(tag)

    if (result === null) {
      break
    }

    if (!result[0].trim()) {
      continue
    }

    if (result[1]) {
      const attr = result[1].trim()
      let arr = [attr, '']

      if (attr.indexOf('=') > -1) {
        arr = attr.split('=')
      }

      res.attribs[arr[0]] = arr[1]
      reg.lastIndex--
    } else if (result[2]) {
      res.attribs[result[2]] = result[3].trim().substring(1, result[3].length - 1)
    }
  }

  return res
}
