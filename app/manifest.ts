import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'OpenMAIC 教学资源工作台',
    short_name: 'OpenMAIC',
    description: '导入、整理和离线使用 OpenMAIC 课程资源。',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#faf8ff',
    theme_color: '#722ed1',
    orientation: 'any',
    categories: ['education', 'productivity'],
    lang: 'zh-CN',
    icons: [
      {
        src: '/openmaic-mark.png',
        sizes: '128x128',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  };
}
