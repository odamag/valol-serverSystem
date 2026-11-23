import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // 新しい API（Rust）。'/api' より先に書く（先に一致したほうが使われるため）
      '/api/v1': {
        target: 'http://localhost:8081',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/games': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
})
