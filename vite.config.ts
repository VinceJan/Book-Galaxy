import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// The renderer chunk is imported lazily from GalaxyCanvas, so on its own the
// browser only discovers it after the entry script runs. Hint it from the HTML
// so it downloads alongside the entry on slow connections.
function preloadRenderer(): Plugin {
  return {
    name: 'preload-renderer',
    transformIndexHtml: {
      order: 'post',
      handler(_html, context) {
        const chunk = Object.values(context.bundle ?? {}).find((item) => item.type === 'chunk' && item.name === 'GalaxyEngine')
        return chunk ? [{ tag: 'link', attrs: { rel: 'modulepreload', href: `./${chunk.fileName}` }, injectTo: 'head' }] : []
      },
    },
  }
}

// The stylesheet is small (~11 KB gzipped); inline it so the first frame paints
// with the HTML alone instead of waiting one more round trip on slow networks.
function inlineStylesheet(): Plugin {
  return {
    name: 'inline-stylesheet',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const html = Object.values(bundle).find((item) => item.type === 'asset' && item.fileName === 'index.html')
      if (!html || html.type !== 'asset') return
      let source = String(html.source)
      for (const item of Object.values(bundle)) {
        if (item.type !== 'asset' || !item.fileName.endsWith('.css')) continue
        const link = new RegExp(`<link rel="stylesheet"[^>]*href="\\./${item.fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`)
        if (!link.test(source)) continue
        source = source.replace(link, () => `<style>${String(item.source)}</style>`)
        delete bundle[item.fileName]
      }
      html.source = source
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [react(), preloadRenderer(), inlineStylesheet()],
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
