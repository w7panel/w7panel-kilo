import { createRouter, createWebHashHistory } from 'vue-router'

const Empty = { render: () => null }
export default createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/nodes' },
    { path: '/nodes', name: 'nodes', component: Empty },
    { path: '/routes', name: 'routes', component: Empty },
    { path: '/peers', name: 'peers', component: Empty },
    { path: '/topology', name: 'topology', component: Empty },
    { path: '/:pathMatch(.*)*', redirect: '/nodes' },
  ],
})
