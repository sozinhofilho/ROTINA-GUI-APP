import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// `vite build --mode demo` gera a demonstração (sem PWA, com API simulada no navegador).
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    mode !== 'demo' &&
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],
        manifest: {
          name: 'Rotina · dieta e treino',
          short_name: 'Rotina',
          description: 'Acompanhamento diário de dieta e treinos',
          lang: 'pt-BR',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          orientation: 'portrait',
          background_color: '#0f1720',
          theme_color: '#0f1720',
          icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api\//],
          globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        },
      }),
  ],
  resolve:
    mode === 'demo'
      ? { alias: { 'virtual:pwa-register': fileURLToPath(new URL('./src/demo-stubs/pwa-register.ts', import.meta.url)) } }
      : {},
  ...(mode === 'demo' ? { base: './', build: { outDir: 'dist-demo' } } : {}),
}))
