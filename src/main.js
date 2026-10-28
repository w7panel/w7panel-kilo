import { createApp } from 'vue'
import ArcoVue from '@arco-design/web-vue'
import ArcoVueIcon from '@arco-design/web-vue/es/icon'
import '@arco-design/web-vue/dist/arco.css'
import App from './App.vue'
import router from './router.js'
import './style.css'

const app = createApp(App)
app.use(ArcoVue).use(ArcoVueIcon).use(router).mount('#app')
