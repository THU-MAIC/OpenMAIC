import type { TurningMode } from '@/lib/types/slides';

export const ANIMATION_DEFAULT_DURATION = 1000;
export const ANIMATION_DEFAULT_TRIGGER = 'click';
export const ANIMATION_CLASS_PREFIX = 'animate__';

export const ENTER_ANIMATIONS = [
  {
    type: 'bounce',
    name: '弹跳',
    children: [
      { name: '弹入', value: 'bounceIn' },
      { name: '向右弹入', value: 'bounceInLeft' },
      { name: '向左弹入', value: 'bounceInRight' },
      { name: '向上弹入', value: 'bounceInUp' },
      { name: '向下弹入', value: 'bounceInDown' },
    ],
  },
  {
    type: 'fade',
    name: '浮现',
    children: [
      { name: '浮入', value: 'fadeIn' },
      { name: '向下浮入', value: 'fadeInDown' },
      { name: '向下长距浮入', value: 'fadeInDownBig' },
      { name: '向右浮入', value: 'fadeInLeft' },
      { name: '向右长距浮入', value: 'fadeInLeftBig' },
      { name: '向左浮入', value: 'fadeInRight' },
      { name: '向左长距浮入', value: 'fadeInRightBig' },
      { name: '向上浮入', value: 'fadeInUp' },
      { name: '向上长距浮入', value: 'fadeInUpBig' },
      { name: '从左上浮入', value: 'fadeInTopLeft' },
      { name: '从右上浮入', value: 'fadeInTopRight' },
      { name: '从左下浮入', value: 'fadeInBottomLeft' },
      { name: '从右下浮入', value: 'fadeInBottomRight' },
    ],
  },
  {
    type: 'rotate',
    name: '旋转',
    children: [
      { name: '旋转进入', value: 'rotateIn' },
      { name: '绕左下进入', value: 'rotateInDownLeft' },
      { name: '绕右下进入', value: 'rotateInDownRight' },
      { name: '绕左上进入', value: 'rotateInUpLeft' },
      { name: '绕右上进入', value: 'rotateInUpRight' },
    ],
  },
  {
    type: 'zoom',
    name: '缩放',
    children: [
      { name: '放大进入', value: 'zoomIn' },
      { name: '向下放大进入', value: 'zoomInDown' },
      { name: '从左放大进入', value: 'zoomInLeft' },
      { name: '从右放大进入', value: 'zoomInRight' },
      { name: '向上放大进入', value: 'zoomInUp' },
    ],
  },
  {
    type: 'slide',
    name: '滑入',
    children: [
      { name: '向下滑入', value: 'slideInDown' },
      { name: '从右滑入', value: 'slideInLeft' },
      { name: '从左滑入', value: 'slideInRight' },
      { name: '向上滑入', value: 'slideInUp' },
    ],
  },
  {
    type: 'flip',
    name: '翻转',
    children: [
      { name: 'X轴翻转进入', value: 'flipInX' },
      { name: 'Y轴翻转进入', value: 'flipInY' },
    ],
  },
  {
    type: 'back',
    name: '放大滑入',
    children: [
      { name: '向下放大滑入', value: 'backInDown' },
      { name: '从左放大滑入', value: 'backInLeft' },
      { name: '从右放大滑入', value: 'backInRight' },
      { name: '向上放大滑入', value: 'backInUp' },
    ],
  },
  {
    type: 'lightSpeed',
    name: '飞入',
    children: [
      { name: '从右飞入', value: 'lightSpeedInRight' },
      { name: '从左飞入', value: 'lightSpeedInLeft' },
    ],
  },
];

export const EXIT_ANIMATIONS = [
  {
    type: 'bounce',
    name: '弹跳',
    children: [
      { name: '弹出', value: 'bounceOut' },
      { name: '向左弹出', value: 'bounceOutLeft' },
      { name: '向右弹出', value: 'bounceOutRight' },
      { name: '向上弹出', value: 'bounceOutUp' },
      { name: '向下弹出', value: 'bounceOutDown' },
    ],
  },
  {
    type: 'fade',
    name: '浮现',
    children: [
      { name: '浮出', value: 'fadeOut' },
      { name: '向下浮出', value: 'fadeOutDown' },
      { name: '向下长距浮出', value: 'fadeOutDownBig' },
      { name: '向左浮出', value: 'fadeOutLeft' },
      { name: '向左长距浮出', value: 'fadeOutLeftBig' },
      { name: '向右浮出', value: 'fadeOutRight' },
      { name: '向右长距浮出', value: 'fadeOutRightBig' },
      { name: '向上浮出', value: 'fadeOutUp' },
      { name: '向上长距浮出', value: 'fadeOutUpBig' },
      { name: '从左上浮出', value: 'fadeOutTopLeft' },
      { name: '从右上浮出', value: 'fadeOutTopRight' },
      { name: '从左下浮出', value: 'fadeOutBottomLeft' },
      { name: '从右下浮出', value: 'fadeOutBottomRight' },
    ],
  },
  {
    type: 'rotate',
    name: '旋转',
    children: [
      { name: '旋转退出', value: 'rotateOut' },
      { name: '绕左下退出', value: 'rotateOutDownLeft' },
      { name: '绕右下退出', value: 'rotateOutDownRight' },
      { name: '绕左上退出', value: 'rotateOutUpLeft' },
      { name: '绕右上退出', value: 'rotateOutUpRight' },
    ],
  },
  {
    type: 'zoom',
    name: '缩放',
    children: [
      { name: '缩小退出', value: 'zoomOut' },
      { name: '向下缩小退出', value: 'zoomOutDown' },
      { name: '从左缩小退出', value: 'zoomOutLeft' },
      { name: '从右缩小退出', value: 'zoomOutRight' },
      { name: '向上缩小退出', value: 'zoomOutUp' },
    ],
  },
  {
    type: 'slide',
    name: '滑出',
    children: [
      { name: '向下滑出', value: 'slideOutDown' },
      { name: '从左滑出', value: 'slideOutLeft' },
      { name: '从右滑出', value: 'slideOutRight' },
      { name: '向上滑出', value: 'slideOutUp' },
    ],
  },
  {
    type: 'flip',
    name: '翻转',
    children: [
      { name: 'X轴翻转退出', value: 'flipOutX' },
      { name: 'Y轴翻转退出', value: 'flipOutY' },
    ],
  },
  {
    type: 'back',
    name: '缩小滑出',
    children: [
      { name: '向下缩小滑出', value: 'backOutDown' },
      { name: '从左缩小滑出', value: 'backOutLeft' },
      { name: '从右缩小滑出', value: 'backOutRight' },
      { name: '向上缩小滑出', value: 'backOutUp' },
    ],
  },
  {
    type: 'lightSpeed',
    name: '飞出',
    children: [
      { name: '从右飞出', value: 'lightSpeedOutRight' },
      { name: '从左飞出', value: 'lightSpeedOutLeft' },
    ],
  },
];

export const ATTENTION_ANIMATIONS = [
  {
    type: 'shake',
    name: '晃动',
    children: [
      { name: '左右摇晃', value: 'shakeX' },
      { name: '上下摇晃', value: 'shakeY' },
      { name: '摇头', value: 'headShake' },
      { name: '摆动', value: 'swing' },
      { name: '晃动', value: 'wobble' },
      { name: '惊恐', value: 'tada' },
      { name: '果冻', value: 'jello' },
    ],
  },
  {
    type: 'other',
    name: '其他',
    children: [
      { name: '弹跳', value: 'bounce' },
      { name: '闪烁', value: 'flash' },
      { name: '脉搏', value: 'pulse' },
      { name: '橡皮筋', value: 'rubberBand' },
      { name: '心跳（快）', value: 'heartBeat' },
    ],
  },
];

interface SlideAnimation {
  label: string;
  value: TurningMode;
}

export const SLIDE_ANIMATIONS: SlideAnimation[] = [
  { label: '无', value: 'no' },
  { label: '随机', value: 'random' },
  { label: '左右推移', value: 'slideX' },
  { label: '上下推移', value: 'slideY' },
  { label: '左右推移（3D）', value: 'slideX3D' },
  { label: '上下推移（3D）', value: 'slideY3D' },
  { label: '淡入淡出', value: 'fade' },
  { label: '旋转', value: 'rotate' },
  { label: '上下展开', value: 'scaleY' },
  { label: '左右展开', value: 'scaleX' },
  { label: '放大', value: 'scale' },
  { label: '缩小', value: 'scaleReverse' },
];
