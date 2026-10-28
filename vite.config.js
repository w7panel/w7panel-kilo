import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const devOrigin = process.env.KILO_DEV_ORIGIN || 'http://172.16.1.3:8015'
const panelOrigin = process.env.KILO_PANEL_ORIGIN || 'http://218.23.2.48:9090'

function panelCors() {
  return {
    name: 'panel-cors',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        response.setHeader('Access-Control-Allow-Origin', panelOrigin)
        response.setHeader('Access-Control-Allow-Credentials', 'true')
        response.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS')
        response.setHeader('Access-Control-Allow-Headers', request.headers['access-control-request-headers'] || 'Content-Type, Authorization, X-W7Panel-Token')
        response.setHeader('Access-Control-Allow-Private-Network', 'true')
        response.setHeader('Vary', 'Origin, Access-Control-Request-Headers, Access-Control-Request-Private-Network')
        if (request.method === 'OPTIONS') return response.end()
        next()
      })
    },
  }
}

export default defineConfig(({ command }) => ({
  base: command === 'serve' ? `${devOrigin}/` : './',
  plugins: [panelCors(), vue()],
  server: { host: '0.0.0.0', origin: devOrigin, cors: false, proxy: { '/local/k8s': `http://127.0.0.1:${process.env.KILO_API_PORT || 8016}` } },
}))
