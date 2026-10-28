import { createRouter, createWebHashHistory } from 'vue-router'

const Empty = { render: () => null }
export default createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/nodes' },
    { path: '/nodes', name: 'nodes', component: Empty },
    { path: '/routes', name: 'routes', component: Empty },
    { path: '/:pathMatch(.*)*', redirect: '/nodes' },
  ],
})
