import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// Keep React/CSS Modules HMR on Vite; production assets are built with Bun.build.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.VITE_PORT || 5173),
    strictPort: true,
    fs: {
      deny: ['.env', '.env.*', '*.{crt,pem,key,p12,pfx}', '**/.git/**', '**/.sessions.json*',
        '**/data/**', '**/files/**', '**/backups/**', '**/*.sqlite*', '**/*.db', '**/*.db-*', '**/manifest*.json'],
    },
    proxy: Object.fromEntries(['/api', '/media', '/uploads', '/thumbnails', '/previews'].map(prefix => [prefix, {
      target: `http://127.0.0.1:${process.env.PORT || 3000}`,
      // Preserve the browser-facing Host so the backend's CSRF origin check still matches.
      changeOrigin: false,
    }])),
  },
})
