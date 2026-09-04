import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = resolve('src/shared')

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } },
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: { alias: { '@': resolve('src/renderer/src'), '@shared': shared } },
    plugins: [react(), tailwindcss()]
  }
})
