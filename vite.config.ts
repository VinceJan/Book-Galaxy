import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rolldownOptions: {
      output: {
        // Curated reading threads are editorial data: split them into two
        // lazily loaded chunks so no single chunk crosses the size budget.
        advancedChunks: {
          groups: [
            { name: 'curated-a', test: /curatedThreads[\\/](?:shard-0[0-5]|world|ideas|chinese)/ },
            { name: 'curated-b', test: /curatedThreads[\\/]/ },
          ],
        },
      },
    },
  },
})
