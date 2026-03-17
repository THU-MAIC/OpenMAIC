import * as entities from 'entities'

import parseTag from './parse-tag'

const tagRE = /<[a-zA-Z0-9\-!/](?:"[^"]*"|'[^']*'|[^'">])*>/g
const whitespaceRE = /^\s*$/

const textContainerNames = ['mtext', 'mi', 'mn', 'mo', 'ms']

// re-used obj for quick lookups of components
const empty = Object.create(null)

export function parse(html, options = {}) {
  const result = []
  const arr = []
  let current
  let level = -1

  html.replace(tagRE, (tag, index) => {
    const isOpen = tag.charAt(1) !== '/'
    const isComment = tag.startsWith('<!--')
    const start = index + tag.length
    const nextChar = html.charAt(start)
    let parent

    if (isComment) {
      const comment = parseTag(tag)

      // if we're at root, push new base node
      if (level < 0) {
        result.push(comment)
        return result
      }
      parent = arr[level]
      parent.children.push(comment)
      return result
    }

    if (isOpen) {
      level++

      current = parseTag(tag)
      if (current.type === 'tag' && options.components?.[current.name]) {
        current.type = 'component'
      }

      if (
        textContainerNames.includes(current.name) &&
        !current.voidElement &&
        nextChar &&
        nextChar !== '<'
      ) {
        const data = html.slice(start, html.indexOf('<', start)).trim()
        current.children.push({
          type: 'text',
          data: options.disableDecode ? data : entities.decodeXML(data)
        })
      }

      // if we're at root, push new base node
      if (level === 0) {
        result.push(current)
      }

      parent = arr[level - 1]

      if (parent) {
        parent.children.push(current)
      }

      arr[level] = current
    }

    if (!isOpen || current.voidElement) {
      if (level > -1 && (current.voidElement || current.name === tag.slice(2, -1))) {
        level--
        // move current up a level to match the end tag
        current = level === -1 ? result : arr[level]
      }
      if (
        level > -1 &&
        textContainerNames.includes[arr[level].name] &&
        nextChar !== '<' &&
        nextChar
      ) {
        // trailing text node
        parent = arr[level].children

        // calculate correct end of the content slice in case there's
        // no tag after the text node.
        const end = html.indexOf('<', start)
        let data = html.slice(start, end === -1 ? undefined : end)
        // if a node is nothing but whitespace, collapse it as the spec states:
        // https://www.w3.org/TR/html4/struct/text.html#h-9.1
        if (whitespaceRE.test(data)) {
          data = ' '
        }
        // don't add whitespace-only text nodes if they would be trailing text nodes
        // or if they would be leading whitespace-only text nodes:
        //  * end > -1 indicates this is not a trailing text node
        //  * leading node is when level is -1 and parent has length 0
        if ((end > -1 && level + parent.length >= 0) || data !== ' ') {
          parent.push({
            type: 'text',
            data: options.disableDecode ? data : entities.decodeXML(data)
          })
        }
      }
    }
  })

  return result
}
