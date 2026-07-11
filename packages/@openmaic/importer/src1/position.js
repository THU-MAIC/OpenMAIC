import { RATIO_EMUs_Points } from './constants'
import { numberToFixed } from './utils'

export function getPosition(slideSpNode, slideLayoutSpNode, slideMasterSpNode) {
  let off

  if (slideSpNode) off = slideSpNode['a:off']['attrs']
  else if (slideLayoutSpNode) off = slideLayoutSpNode['a:off']['attrs']
  else if (slideMasterSpNode) off = slideMasterSpNode['a:off']['attrs']

  if (!off) return { top: 0, left: 0 }

  return {
    top: numberToFixed(parseInt(off['y']) * RATIO_EMUs_Points),
    left: numberToFixed(parseInt(off['x']) * RATIO_EMUs_Points),
  }
}

export function getSize(slideSpNode, slideLayoutSpNode, slideMasterSpNode) {
  let ext

  if (slideSpNode) ext = slideSpNode['a:ext']['attrs']
  else if (slideLayoutSpNode) ext = slideLayoutSpNode['a:ext']['attrs']
  else if (slideMasterSpNode) ext = slideMasterSpNode['a:ext']['attrs']

  if (!ext) return { width: 0, height: 0 }

  return {
    width: numberToFixed(parseInt(ext['cx']) * RATIO_EMUs_Points),
    height: numberToFixed(parseInt(ext['cy']) * RATIO_EMUs_Points),
  }
}