import type { MetadataRoute } from 'next';

/**
 * Web app manifest (DEC-005 option B: responsive portal + PWA). Next.js serves it at
 * /manifest.webmanifest and links it from every page.
 *
 * Deliberately NO service worker: nothing (in particular no personal / payroll data) is cached
 * for offline use. "Install to home screen" works without one on iOS and Android; if a worker is
 * ever added it must be network-only for /api and authenticated pages.
 *
 * Icons: public/icons/*, generated from public/logo.png on the UI's blue -> indigo gradient.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'رديف - إدارة الموارد البشرية',
    short_name: 'رديف',
    description: 'نظام رديف لإدارة الموارد البشرية وبوابة الخدمة الذاتية للموظفين',
    lang: 'ar',
    dir: 'rtl',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    // Same colours as the UI: dark shell/sidebar (viewport themeColor) and the light page background.
    theme_color: '#0A0B10',
    background_color: '#f8fafc',
    categories: ['business', 'productivity'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/apple-touch-icon-180.png', sizes: '180x180', type: 'image/png' },
    ],
    shortcuts: [
      { name: 'بوابة الموظف', short_name: 'بوابتي', url: '/portal', icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }] },
    ],
  };
}
