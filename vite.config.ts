import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/recharts/') || id.includes('/d3-')) return 'charts'
          if (id.includes('/@base-ui/') || id.includes('/sonner/')) return 'ui'
          if (id.includes('/zustand/')) return 'state'
          if (id.includes('/react/') || id.includes('/react-dom/')) return 'react'
        },
      },
    },
  },
})
