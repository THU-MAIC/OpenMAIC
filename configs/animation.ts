import type { TurningMode } from '@/lib/types/slides';

export const ANIMATION_DEFAULT_DURATION = 1000;
export const ANIMATION_DEFAULT_TRIGGER = 'click';
export const ANIMATION_CLASS_PREFIX = 'animate__';

export const ENTER_ANIMATIONS = [
  {
    type: 'bounce',
    name: '',
    children: [
      { name: '', value: 'bounceIn' },
      { name: '', value: 'bounceInLeft' },
      { name: '', value: 'bounceInRight' },
      { name: '', value: 'bounceInUp' },
      { name: '', value: 'bounceInDown' },
    ],
  },
  {
    type: 'fade',
    name: '',
    children: [
      { name: '', value: 'fadeIn' },
      { name: '', value: 'fadeInDown' },
      { name: '', value: 'fadeInDownBig' },
      { name: '', value: 'fadeInLeft' },
      { name: '', value: 'fadeInLeftBig' },
      { name: '', value: 'fadeInRight' },
      { name: '', value: 'fadeInRightBig' },
      { name: '', value: 'fadeInUp' },
      { name: '', value: 'fadeInUpBig' },
      { name: '', value: 'fadeInTopLeft' },
      { name: '', value: 'fadeInTopRight' },
      { name: '', value: 'fadeInBottomLeft' },
      { name: '', value: 'fadeInBottomRight' },
    ],
  },
  {
    type: 'rotate',
    name: '',
    children: [
      { name: '', value: 'rotateIn' },
      { name: '', value: 'rotateInDownLeft' },
      { name: '', value: 'rotateInDownRight' },
      { name: '', value: 'rotateInUpLeft' },
      { name: '', value: 'rotateInUpRight' },
    ],
  },
  {
    type: 'zoom',
    name: '',
    children: [
      { name: '', value: 'zoomIn' },
      { name: '', value: 'zoomInDown' },
      { name: '', value: 'zoomInLeft' },
      { name: '', value: 'zoomInRight' },
      { name: '', value: 'zoomInUp' },
    ],
  },
  {
    type: 'slide',
    name: '',
    children: [
      { name: '', value: 'slideInDown' },
      { name: '', value: 'slideInLeft' },
      { name: '', value: 'slideInRight' },
      { name: '', value: 'slideInUp' },
    ],
  },
  {
    type: 'flip',
    name: '',
    children: [
      { name: 'X', value: 'flipInX' },
      { name: 'Y', value: 'flipInY' },
    ],
  },
  {
    type: 'back',
    name: '',
    children: [
      { name: '', value: 'backInDown' },
      { name: '', value: 'backInLeft' },
      { name: '', value: 'backInRight' },
      { name: '', value: 'backInUp' },
    ],
  },
  {
    type: 'lightSpeed',
    name: '',
    children: [
      { name: '', value: 'lightSpeedInRight' },
      { name: '', value: 'lightSpeedInLeft' },
    ],
  },
];

export const EXIT_ANIMATIONS = [
  {
    type: 'bounce',
    name: '',
    children: [
      { name: '', value: 'bounceOut' },
      { name: '', value: 'bounceOutLeft' },
      { name: '', value: 'bounceOutRight' },
      { name: '', value: 'bounceOutUp' },
      { name: '', value: 'bounceOutDown' },
    ],
  },
  {
    type: 'fade',
    name: '',
    children: [
      { name: '', value: 'fadeOut' },
      { name: '', value: 'fadeOutDown' },
      { name: '', value: 'fadeOutDownBig' },
      { name: '', value: 'fadeOutLeft' },
      { name: '', value: 'fadeOutLeftBig' },
      { name: '', value: 'fadeOutRight' },
      { name: '', value: 'fadeOutRightBig' },
      { name: '', value: 'fadeOutUp' },
      { name: '', value: 'fadeOutUpBig' },
      { name: '', value: 'fadeOutTopLeft' },
      { name: '', value: 'fadeOutTopRight' },
      { name: '', value: 'fadeOutBottomLeft' },
      { name: '', value: 'fadeOutBottomRight' },
    ],
  },
  {
    type: 'rotate',
    name: '',
    children: [
      { name: '', value: 'rotateOut' },
      { name: '', value: 'rotateOutDownLeft' },
      { name: '', value: 'rotateOutDownRight' },
      { name: '', value: 'rotateOutUpLeft' },
      { name: '', value: 'rotateOutUpRight' },
    ],
  },
  {
    type: 'zoom',
    name: '',
    children: [
      { name: '', value: 'zoomOut' },
      { name: '', value: 'zoomOutDown' },
      { name: '', value: 'zoomOutLeft' },
      { name: '', value: 'zoomOutRight' },
      { name: '', value: 'zoomOutUp' },
    ],
  },
  {
    type: 'slide',
    name: '',
    children: [
      { name: '', value: 'slideOutDown' },
      { name: '', value: 'slideOutLeft' },
      { name: '', value: 'slideOutRight' },
      { name: '', value: 'slideOutUp' },
    ],
  },
  {
    type: 'flip',
    name: '',
    children: [
      { name: 'X', value: 'flipOutX' },
      { name: 'Y', value: 'flipOutY' },
    ],
  },
  {
    type: 'back',
    name: '',
    children: [
      { name: '', value: 'backOutDown' },
      { name: '', value: 'backOutLeft' },
      { name: '', value: 'backOutRight' },
      { name: '', value: 'backOutUp' },
    ],
  },
  {
    type: 'lightSpeed',
    name: '',
    children: [
      { name: '', value: 'lightSpeedOutRight' },
      { name: '', value: 'lightSpeedOutLeft' },
    ],
  },
];

export const ATTENTION_ANIMATIONS = [
  {
    type: 'shake',
    name: '',
    children: [
      { name: '', value: 'shakeX' },
      { name: '', value: 'shakeY' },
      { name: '', value: 'headShake' },
      { name: '', value: 'swing' },
      { name: '', value: 'wobble' },
      { name: '', value: 'tada' },
      { name: '', value: 'jello' },
    ],
  },
  {
    type: 'other',
    name: '',
    children: [
      { name: '', value: 'bounce' },
      { name: '', value: 'flash' },
      { name: '', value: 'pulse' },
      { name: '', value: 'rubberBand' },
      { name: '（）', value: 'heartBeat' },
    ],
  },
];

interface SlideAnimation {
  label: string;
  value: TurningMode;
}

export const SLIDE_ANIMATIONS: SlideAnimation[] = [
  { label: '', value: 'no' },
  { label: '', value: 'random' },
  { label: '', value: 'slideX' },
  { label: '', value: 'slideY' },
  { label: '（3D）', value: 'slideX3D' },
  { label: '（3D）', value: 'slideY3D' },
  { label: '', value: 'fade' },
  { label: '', value: 'rotate' },
  { label: '', value: 'scaleY' },
  { label: '', value: 'scaleX' },
  { label: '', value: 'scale' },
  { label: '', value: 'scaleReverse' },
];
