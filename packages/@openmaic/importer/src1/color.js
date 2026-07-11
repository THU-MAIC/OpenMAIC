import tinycolor from 'tinycolor2'

export function hueToRgb(t1, t2, hue) {
  if (hue < 0) hue += 6
  if (hue >= 6) hue -= 6
  if (hue < 1) return (t2 - t1) * hue + t1
  else if (hue < 3) return t2
  else if (hue < 4) return (t2 - t1) * (4 - hue) + t1
  return t1
}

export function hslToRgb(hue, sat, light) {
  let t2
  hue = hue / 60
  if (light <= 0.5) {
    t2 = light * (sat + 1)
  } 
  else {
    t2 = light + sat - (light * sat)
  }
  const t1 = light * 2 - t2
  const r = hueToRgb(t1, t2, hue + 2) * 255
  const g = hueToRgb(t1, t2, hue) * 255
  const b = hueToRgb(t1, t2, hue - 2) * 255
  return { r, g, b }
}

export function applyShade(rgbStr, shadeValue, isAlpha) {
  const color = tinycolor(rgbStr).toHsl()
  if (shadeValue >= 1) shadeValue = 1
  const cacl_l = Math.min(color.l * shadeValue, 1)
  if (isAlpha) {
    return tinycolor({
      h: color.h,
      s: color.s,
      l: cacl_l,
      a: color.a
    }).toHex8()
  }

  return tinycolor({
    h: color.h,
    s: color.s,
    l: cacl_l,
    a: color.a,
  }).toHex()
}

export function applyTint(rgbStr, tintValue, isAlpha) {
  const color = tinycolor(rgbStr).toHsl()
  if (tintValue >= 1) tintValue = 1
  const cacl_l = color.l * tintValue + (1 - tintValue)
  if (isAlpha) {
    return tinycolor({
      h: color.h,
      s: color.s,
      l: cacl_l,
      a: color.a
    }).toHex8()
  }

  return tinycolor({
    h: color.h,
    s: color.s,
    l: cacl_l,
    a: color.a
  }).toHex()
}

export function applyLumOff(rgbStr, offset, isAlpha) {
  const color = tinycolor(rgbStr).toHsl()
  const lum = offset + color.l
  if (lum >= 1) {
    if (isAlpha) {
      return tinycolor({
        h: color.h,
        s: color.s,
        l: 1,
        a: color.a
      }).toHex8()
    }
      
    return tinycolor({
      h: color.h,
      s: color.s,
      l: 1,
      a: color.a
    }).toHex()
  }
  if (isAlpha) {
    return tinycolor({
      h: color.h,
      s: color.s,
      l: lum,
      a: color.a
    }).toHex8()
  }

  return tinycolor({
    h: color.h,
    s: color.s,
    l: lum,
    a: color.a
  }).toHex()
}

export function applyLumMod(rgbStr, multiplier, isAlpha) {
  const color = tinycolor(rgbStr).toHsl()
  let cacl_l = color.l * multiplier
  if (cacl_l >= 1) cacl_l = 1
  if (isAlpha) {
    return tinycolor({
      h: color.h,
      s: color.s,
      l: cacl_l,
      a: color.a
    }).toHex8()
  }

  return tinycolor({
    h: color.h,
    s: color.s,
    l: cacl_l,
    a: color.a
  }).toHex()
}

export function applyHueMod(rgbStr, multiplier, isAlpha) {
  const color = tinycolor(rgbStr).toHsl()
  let cacl_h = color.h * multiplier
  if (cacl_h >= 360) cacl_h = cacl_h - 360
  if (isAlpha) {
    return tinycolor({
      h: cacl_h,
      s: color.s,
      l: color.l,
      a: color.a
    }).toHex8()
  }

  return tinycolor({
    h: cacl_h,
    s: color.s,
    l: color.l,
    a: color.a
  }).toHex()
}

export function applySatMod(rgbStr, multiplier, isAlpha) {
  const color = tinycolor(rgbStr).toHsl()
  let cacl_s = color.s * multiplier
  if (cacl_s >= 1) cacl_s = 1
  if (isAlpha) {
    return tinycolor({
      h: color.h,
      s: cacl_s,
      l: color.l,
      a: color.a
    }).toHex8()
  }

  return tinycolor({
    h: color.h,
    s: cacl_s,
    l: color.l,
    a: color.a
  }).toHex()
}

export function getColorName2Hex(name) {
  let hex
  const colorName = ['AliceBlue', 'AntiqueWhite', 'Aqua', 'Aquamarine', 'Azure', 'Beige', 'Bisque', 'black', 'BlanchedAlmond', 'Blue', 'BlueViolet', 'Brown', 'BurlyWood', 'CadetBlue', 'Chartreuse', 'Chocolate', 'Coral', 'CornflowerBlue', 'Cornsilk', 'Crimson', 'Cyan', 'DarkBlue', 'DarkCyan', 'DarkGoldenRod', 'DarkGray', 'DarkGrey', 'DarkGreen', 'DarkKhaki', 'DarkMagenta', 'DarkOliveGreen', 'DarkOrange', 'DarkOrchid', 'DarkRed', 'DarkSalmon', 'DarkSeaGreen', 'DarkSlateBlue', 'DarkSlateGray', 'DarkSlateGrey', 'DarkTurquoise', 'DarkViolet', 'DeepPink', 'DeepSkyBlue', 'DimGray', 'DimGrey', 'DodgerBlue', 'FireBrick', 'FloralWhite', 'ForestGreen', 'Fuchsia', 'Gainsboro', 'GhostWhite', 'Gold', 'GoldenRod', 'Gray', 'Grey', 'Green', 'GreenYellow', 'HoneyDew', 'HotPink', 'IndianRed', 'Indigo', 'Ivory', 'Khaki', 'Lavender', 'LavenderBlush', 'LawnGreen', 'LemonChiffon', 'LightBlue', 'LightCoral', 'LightCyan', 'LightGoldenRodYellow', 'LightGray', 'LightGrey', 'LightGreen', 'LightPink', 'LightSalmon', 'LightSeaGreen', 'LightSkyBlue', 'LightSlateGray', 'LightSlateGrey', 'LightSteelBlue', 'LightYellow', 'Lime', 'LimeGreen', 'Linen', 'Magenta', 'Maroon', 'MediumAquaMarine', 'MediumBlue', 'MediumOrchid', 'MediumPurple', 'MediumSeaGreen', 'MediumSlateBlue', 'MediumSpringGreen', 'MediumTurquoise', 'MediumVioletRed', 'MidnightBlue', 'MintCream', 'MistyRose', 'Moccasin', 'NavajoWhite', 'Navy', 'OldLace', 'Olive', 'OliveDrab', 'Orange', 'OrangeRed', 'Orchid', 'PaleGoldenRod', 'PaleGreen', 'PaleTurquoise', 'PaleVioletRed', 'PapayaWhip', 'PeachPuff', 'Peru', 'Pink', 'Plum', 'PowderBlue', 'Purple', 'RebeccaPurple', 'Red', 'RosyBrown', 'RoyalBlue', 'SaddleBrown', 'Salmon', 'SandyBrown', 'SeaGreen', 'SeaShell', 'Sienna', 'Silver', 'SkyBlue', 'SlateBlue', 'SlateGray', 'SlateGrey', 'Snow', 'SpringGreen', 'SteelBlue', 'Tan', 'Teal', 'Thistle', 'Tomato', 'Turquoise', 'Violet', 'Wheat', 'White', 'WhiteSmoke', 'Yellow', 'YellowGreen']
  const colorHex = ['f0f8ff', 'faebd7', '00ffff', '7fffd4', 'f0ffff', 'f5f5dc', 'ffe4c4', '000000', 'ffebcd', '0000ff', '8a2be2', 'a52a2a', 'deb887', '5f9ea0', '7fff00', 'd2691e', 'ff7f50', '6495ed', 'fff8dc', 'dc143c', '00ffff', '00008b', '008b8b', 'b8860b', 'a9a9a9', 'a9a9a9', '006400', 'bdb76b', '8b008b', '556b2f', 'ff8c00', '9932cc', '8b0000', 'e9967a', '8fbc8f', '483d8b', '2f4f4f', '2f4f4f', '00ced1', '9400d3', 'ff1493', '00bfff', '696969', '696969', '1e90ff', 'b22222', 'fffaf0', '228b22', 'ff00ff', 'dcdcdc', 'f8f8ff', 'ffd700', 'daa520', '808080', '808080', '008000', 'adff2f', 'f0fff0', 'ff69b4', 'cd5c5c', '4b0082', 'fffff0', 'f0e68c', 'e6e6fa', 'fff0f5', '7cfc00', 'fffacd', 'add8e6', 'f08080', 'e0ffff', 'fafad2', 'd3d3d3', 'd3d3d3', '90ee90', 'ffb6c1', 'ffa07a', '20b2aa', '87cefa', '778899', '778899', 'b0c4de', 'ffffe0', '00ff00', '32cd32', 'faf0e6', 'ff00ff', '800000', '66cdaa', '0000cd', 'ba55d3', '9370db', '3cb371', '7b68ee', '00fa9a', '48d1cc', 'c71585', '191970', 'f5fffa', 'ffe4e1', 'ffe4b5', 'ffdead', '000080', 'fdf5e6', '808000', '6b8e23', 'ffa500', 'ff4500', 'da70d6', 'eee8aa', '98fb98', 'afeeee', 'db7093', 'ffefd5', 'ffdab9', 'cd853f', 'ffc0cb', 'dda0dd', 'b0e0e6', '800080', '663399', 'ff0000', 'bc8f8f', '4169e1', '8b4513', 'fa8072', 'f4a460', '2e8b57', 'fff5ee', 'a0522d', 'c0c0c0', '87ceeb', '6a5acd', '708090', '708090', 'fffafa', '00ff7f', '4682b4', 'd2b48c', '008080', 'd8bfd8', 'ff6347', '40e0d0', 'ee82ee', 'f5deb3', 'ffffff', 'f5f5f5', 'ffff00', '9acd32']
  const nameLower = name.toLowerCase()
  const findIndx = colorName.findIndex(n => n.toLowerCase() === nameLower)
  if (findIndx !== -1) hex = colorHex[findIndx]
  return hex
}