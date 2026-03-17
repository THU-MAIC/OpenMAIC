import type { PPTElementOutline, PPTElementShadow } from '@/lib/types/slides';

export interface PresetTheme {
  background: string;
  fontColor: string;
  fontname: string;
  colors: string[];
  borderColor?: string;
  outline?: PPTElementOutline;
  shadow?: PPTElementShadow;
}

export const PRESET_THEMES: PresetTheme[] = [
  {
    background: '#ffffff',
    fontColor: '#333333',
    borderColor: '#41719c',
    fontname: '',
    colors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47'],
  },
  {
    background: '#ffffff',
    fontColor: '#333333',
    borderColor: '#5f6f1c',
    fontname: '',
    colors: ['#83992a', '#3c9670', '#44709d', '#a23b32', '#d87728', '#deb340'],
  },
  {
    background: '#ffffff',
    fontColor: '#333333',
    borderColor: '#a75f0a',
    fontname: '',
    colors: ['#e48312', '#bd582c', '#865640', '#9b8357', '#c2bc80', '#94a088'],
  },
  {
    background: '#ffffff',
    fontColor: '#333333',
    borderColor: '#7c91a8',
    fontname: '',
    colors: ['#bdc8df', '#003fa9', '#f5ba00', '#ff7567', '#7676d9', '#923ffc'],
  },
  {
    background: '#ffffff',
    fontColor: '#333333',
    borderColor: '#688e19',
    fontname: '',
    colors: ['#90c225', '#54a121', '#e6b91e', '#e86618', '#c42f19', '#918756'],
  },
  {
    background: '#ffffff',
    fontColor: '#333333',
    borderColor: '#4495b0',
    fontname: '',
    colors: ['#1cade4', '#2683c6', '#27ced7', '#42ba97', '#3e8853', '#62a39f'],
  },
  {
    background: '#e9efd6',
    fontColor: '#333333',
    borderColor: '#782009',
    fontname: '',
    colors: ['#a5300f', '#de7e18', '#9f8351', '#728653', '#92aa4c', '#6aac91'],
  },
  {
    background: '#17444e',
    fontColor: '#ffffff',
    borderColor: '#800c0b',
    fontname: '',
    colors: ['#b01513', '#ea6312', '#e6b729', '#6bab90', '#55839a', '#9e5d9d'],
  },
  {
    background: '#36234d',
    fontColor: '#ffffff',
    borderColor: '#830949',
    fontname: '',
    colors: ['#b31166', '#e33d6f', '#e45f3c', '#e9943a', '#9b6bf2', '#d63cd0'],
  },
  {
    background: '#247fad',
    fontColor: '#ffffff',
    borderColor: '#032e45',
    fontname: '',
    colors: ['#052f61', '#a50e82', '#14967c', '#6a9e1f', '#e87d37', '#c62324'],
  },
  {
    background: '#103f55',
    fontColor: '#ffffff',
    borderColor: '#2d7f8a',
    fontname: '',
    colors: ['#40aebd', '#97e8d5', '#a1cf49', '#628f3e', '#f2df3a', '#fcb01c'],
  },
  {
    background: '#242367',
    fontColor: '#ffffff',
    borderColor: '#7d2b8d',
    fontname: '',
    colors: ['#ac3ec1', '#477bd1', '#46b298', '#90ba4c', '#dd9d31', '#e25345'],
  },
  {
    background: '#e4b75e',
    fontColor: '#333333',
    borderColor: '#b68317',
    fontname: '',
    colors: ['#a5644e', '#b58b80', '#c3986d', '#a19574', '#c17529', '#826277'],
  },
  {
    background: '#333333',
    fontColor: '#ffffff',
    borderColor: '#7c91a8',
    fontname: '',
    colors: ['#bdc8df', '#003fa9', '#f5ba00', '#ff7567', '#7676d9', '#923ffc'],
  },
  {
    background: '#2b2b2d',
    fontColor: '#ffffff',
    borderColor: '#893011',
    fontname: '',
    colors: ['#bc451b', '#d3ba68', '#bb8640', '#ad9277', '#a55a43', '#ad9d7b'],
  },
  {
    background: '#171b1e',
    fontColor: '#ffffff',
    borderColor: '#505050',
    fontname: '',
    colors: ['#6f6f6f', '#bfbfa5', '#dbd084', '#e7bf5f', '#e9a039', '#cf7133'],
  },
];
