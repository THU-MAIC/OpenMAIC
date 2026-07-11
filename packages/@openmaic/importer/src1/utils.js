export function base64ArrayBuffer(arrayBuffer) {
  const encodings = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes = new Uint8Array(arrayBuffer)
  const byteLength = bytes.byteLength
  const byteRemainder = byteLength % 3
  const mainLength = byteLength - byteRemainder
  
  let base64 = ''
  let a, b, c, d
  let chunk

  for (let i = 0; i < mainLength; i = i + 3) {
    chunk = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    a = (chunk & 16515072) >> 18
    b = (chunk & 258048) >> 12
    c = (chunk & 4032) >> 6
    d = chunk & 63
    base64 += encodings[a] + encodings[b] + encodings[c] + encodings[d]
  }

  if (byteRemainder === 1) {
    chunk = bytes[mainLength]
    a = (chunk & 252) >> 2
    b = (chunk & 3) << 4
    base64 += encodings[a] + encodings[b] + '=='
  } 
  else if (byteRemainder === 2) {
    chunk = (bytes[mainLength] << 8) | bytes[mainLength + 1]
    a = (chunk & 64512) >> 10
    b = (chunk & 1008) >> 4
    c = (chunk & 15) << 2
    base64 += encodings[a] + encodings[b] + encodings[c] + '='
  }

  return base64
}

export function extractFileExtension(filename) {
  return filename.substr((~-filename.lastIndexOf('.') >>> 0) + 2)
}

export function eachElement(node, func) {
  if (!node) return node

  let result = ''
  if (node.constructor === Array) {
    for (let i = 0; i < node.length; i++) {
      result += func(node[i], i)
    }
  } 
  else result += func(node, 0)

  return result
}

export function getTextByPathList(node, path) {
  if (!node) return node

  for (const key of path) {
    node = node[key]
    if (!node) return node
  }

  return node
}

export function angleToDegrees(angle) {
  if (!angle) return 0
  return Math.round(angle / 60000)
}

export function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }
  return text.replace(/[&<>"']/g, m => map[m])
}

export function getMimeType(imgFileExt) {
  let mimeType = ''
  switch (imgFileExt.toLowerCase()) {
    case 'jpg':
    case 'jpeg':
      mimeType = 'image/jpeg'
      break
    case 'png':
      mimeType = 'image/png'
      break
    case 'gif':
      mimeType = 'image/gif'
      break
    case 'emf':
      mimeType = 'image/x-emf'
      break
    case 'wmf':
      mimeType = 'image/x-wmf'
      break
    case 'svg':
      mimeType = 'image/svg+xml'
      break
    case 'mp4':
      mimeType = 'video/mp4'
      break
    case 'webm':
      mimeType = 'video/webm'
      break
    case 'ogg':
      mimeType = 'video/ogg'
      break
    case 'avi':
      mimeType = 'video/avi'
      break
    case 'mpg':
      mimeType = 'video/mpg'
      break
    case 'wmv':
      mimeType = 'video/wmv'
      break
    case 'mp3':
      mimeType = 'audio/mpeg'
      break
    case 'wav':
      mimeType = 'audio/wav'
      break
    case 'tif':
      mimeType = 'image/tiff'
      break
    case 'tiff':
      mimeType = 'image/tiff'
      break
    default:
  }
  return mimeType
}

export function isVideoLink(vdoFile) {
  const urlRegex = /^(https?|ftp):\/\/([a-zA-Z0-9.-]+(:[a-zA-Z0-9.&%$-]+)*@)*((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]?)(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}|([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,})(:[0-9]+)*(\/($|[a-zA-Z0-9.,?'\\+&%$#=~_-]+))*$/
  return urlRegex.test(vdoFile)
}

export function toHex(n) {
  let hex = n.toString(16)
  while (hex.length < 2) {
    hex = '0' + hex
  }
  return hex
}

export function hasValidText(htmlString) {
  if (typeof DOMParser === 'undefined') {
    const text = htmlString.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')
    return text.trim() !== ''
  }

  const parser = new DOMParser()
  const doc = parser.parseFromString(htmlString, 'text/html')
  const text = doc.body.textContent || doc.body.innerText
  return text.trim() !== ''
}

export function numberToFixed(num, fractionDigits = 4) {
  return parseFloat(num.toFixed(fractionDigits))
}