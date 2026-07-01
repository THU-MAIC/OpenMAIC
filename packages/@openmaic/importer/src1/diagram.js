import { getTextByPathList } from './utils'

export function getSmartArtTextData(dataContent) {
  const result = []

  let ptLst = getTextByPathList(dataContent, ['dgm:dataModel', 'dgm:ptLst', 'dgm:pt'])

  if (!ptLst) return result
  if (!Array.isArray(ptLst)) ptLst = [ptLst]

  for (const pt of ptLst) {
    const textBody = getTextByPathList(pt, ['dgm:t'])

    if (textBody) {
      let nodeText = ''

      let paragraphs = getTextByPathList(textBody, ['a:p'])
      if (paragraphs) {
        if (!Array.isArray(paragraphs)) paragraphs = [paragraphs]

        paragraphs.forEach(p => {
          let runs = getTextByPathList(p, ['a:r'])
          if (runs) {
            if (!Array.isArray(runs)) runs = [runs]

            runs.forEach(r => {
              const t = getTextByPathList(r, ['a:t'])
              if (t && typeof t === 'string') nodeText += t
            })
          }
          if (nodeText.length > 0) nodeText += '\n'
        })
      }

      const cleanText = nodeText.trim()
      if (cleanText) {
        result.push(cleanText)
      }
    }
  }

  return result
}