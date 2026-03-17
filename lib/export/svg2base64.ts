// Convert SVG to base64 image. Reference: https://github.com/scriptex/svg64

const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
const PREFIX = 'data:image/svg+xml;base64,';

const utf8Encode = (string: string) => {
  string = string.replace(/\r\n/g, '\n');
  let utftext = '';

  for (let n = 0; n < string.length; n++) {
    const c = string.charCodeAt(n);

    if (c < 128) {
      utftext += String.fromCharCode(c);
    } else if (c > 127 && c < 2048) {
      utftext += String.fromCharCode((c >> 6) | 192);
      utftext += String.fromCharCode((c & 63) | 128);
    } else {
      utftext += String.fromCharCode((c >> 12) | 224);
      utftext += String.fromCharCode(((c >> 6) & 63) | 128);
      utftext += String.fromCharCode((c & 63) | 128);
    }
  }

  return utftext;
};

const encode = (input: string) => {
  let output = '';
  let chr1, chr2, chr3, enc1, enc2, enc3, enc4;
  let i = 0;
  input = utf8Encode(input);
  while (i < input.length) {
    chr1 = input.charCodeAt(i++);
    chr2 = input.charCodeAt(i++);
    chr3 = input.charCodeAt(i++);
    enc1 = chr1 >> 2;
    enc2 = ((chr1 & 3) << 4) | (chr2 >> 4);
    enc3 = ((chr2 & 15) << 2) | (chr3 >> 6);
    enc4 = chr3 & 63;
    if (isNaN(chr2)) enc3 = enc4 = 64;
    else if (isNaN(chr3)) enc4 = 64;
    output =
      output +
      characters.charAt(enc1) +
      characters.charAt(enc2) +
      characters.charAt(enc3) +
      characters.charAt(enc4);
  }
  return output;
};

export const svg2Base64 = (element: Element) => {
  const XMLS = new XMLSerializer();
  const svg = XMLS.serializeToString(element);

  return PREFIX + encode(svg);
};
