<template>
  <div class="app-shell">
    <header class="masthead">
      <div class="brand"><span class="brand-mark">K</span><span><strong>Kilo 组网</strong><small>节点与区域路由</small></span></div>
      <a-button :loading="loading" @click="refresh"><template #icon><icon-refresh /></template>刷新</a-button>
    </header>

    <main class="workspace">
      <div class="page-heading">
        <div><p class="eyebrow">NETWORK / KILO</p><h1>组网管理</h1><p class="intro">按区域查看节点，指定连接其他区域的 leader，并管理目标网段。</p></div>
        <div class="node-count"><b>{{ visibleNodes.length }}</b><span>已加入节点</span></div>
      </div>

      <nav class="tabs" aria-label="组网页面">
        <router-link to="/nodes" :class="{ active: active === 'nodes' }">节点</router-link>
        <router-link to="/routes" :class="{ active: active === 'routes' }">静态路由</router-link>
      </nav>

      <a-alert v-if="error" type="error" class="load-error" :show-icon="true">{{ error }}</a-alert>

      <section v-if="active === 'nodes'" class="tab-content">
        <div class="section-head"><div><h2>节点区域</h2><p>区域内节点共用一个组网入口；未设置区域的节点归入“默认”。</p></div><a-button :disabled="!selected.length" @click="openMove">设置区域<span v-if="selected.length">（{{ selected.length }}）</span></a-button></div>
        <div v-if="!groups.length && !loading" class="empty-state">尚无加入 Kilo 组网的节点。请确认 Kilo 已在集群节点上运行。</div>
        <div v-for="group in groups" :key="group.region" class="region-card">
          <div class="region-head"><div class="region-title"><span class="region-dot"></span><div><span class="region-kicker">区域 · {{ group.members.length }} 个节点</span><h3>{{ regionName(group.region) }}</h3></div></div><div class="region-leader"><span>区域 leader</span><b>{{ group.leaders.length === 1 ? nodeName(group.leaders[0]) : group.leaders.length ? '配置冲突' : 'Kilo 自动选举' }}</b></div></div>
          <div class="table-scroll"><table class="data-table"><thead><tr><th class="check-col"><a-checkbox :model-value="group.members.every((node) => selected.includes(nodeName(node)))" @change="(checked) => selectGroup(group, checked)" :aria-label="`选择 ${regionName(group.region)} 区域全部节点`" /></th><th>节点</th><th>内网 IP</th><th>组网 IP</th><th>公网地址</th><th>操作</th></tr></thead><tbody>
            <tr v-for="node in group.members" :key="nodeName(node)"><td><a-checkbox :model-value="selected.includes(nodeName(node))" @change="(checked) => selectNode(nodeName(node), checked)" :aria-label="`选择节点 ${nodeName(node)}`" /></td><td class="node-name"><span>{{ nodeName(node) }}</span><em v-if="hasManualLeader(node)">LEADER</em></td><td class="mono">{{ internalIP(node) || '—' }}</td><td class="mono">{{ group.meshIP || '—' }}<small v-if="group.meshIP" class="shared-label">区域共享</small></td><td class="mono">{{ publicIP(node) || '—' }}</td><td><a-button size="small" type="text" :disabled="busy || (group.leaders.length === 1 && nodeName(group.leaders[0]) === nodeName(node))" @click="chooseLeader(group, node)">设为 leader</a-button></td></tr>
          </tbody></table></div>
        </div>
      </section>

      <section v-else class="tab-content">
        <div class="section-head"><div><h2>静态路由</h2><p>目标网段由所选区域对外提供，配置保存在该区域 leader 上。</p></div><a-button type="primary" @click="openAdd">添加静态路由</a-button></div>
        <div class="route-card"><div v-if="!routes.length && !loading" class="empty-state">暂无静态路由。先在节点页为区域指定 leader，再添加目标网段。</div><div v-else class="table-scroll"><table class="data-table"><thead><tr><th>区域</th><th>目标网段</th><th>区域 leader</th><th>操作</th></tr></thead><tbody><tr v-for="routeItem in routes" :key="routeItem.id"><td>{{ regionName(routeItem.region) }}</td><td class="mono">{{ routeItem.cidr }}</td><td>{{ leaderName(routeItem.region) }}</td><td><a-popconfirm content="确定删除这条静态路由？" @ok="removeRoute(routeItem)"><a-button type="text" status="danger" size="small" :disabled="busy">删除</a-button></a-popconfirm></td></tr></tbody></table></div></div>
      </section>
    </main>

    <a-modal v-model:visible="moveVisible" title="设置节点区域" :ok-loading="busy" @ok="saveMove" @cancel="moveVisible = false"><p class="modal-hint">将 {{ selected.length }} 个节点划入指定区域。输入现有或新的区域名称。</p><a-input v-model="moveRegion" placeholder="区域名称；留空表示默认区域" :max-length="63" /><div class="region-choices"><a-tag v-for="group in groups" :key="group.region" class="choice-tag" @click="moveRegion = group.region">{{ regionName(group.region) }}</a-tag></div></a-modal>
    <a-modal v-model:visible="addVisible" title="添加静态路由" :ok-loading="busy" @ok="saveRoute" @cancel="addVisible = false"><a-form :model="newRoute" layout="vertical"><a-form-item label="区域"><a-select v-model="newRoute.region" placeholder="选择区域"><a-option v-for="group in groups" :key="group.region || 'default'" :value="group.region">{{ regionName(group.region) }}</a-option></a-select></a-form-item><a-form-item label="目标网段"><a-input v-model="newRoute.cidr" placeholder="例如 10.0.0.0/24" /></a-form-item></a-form><p class="modal-hint">该网段将从其他区域通过 Kilo 路由到所选区域。</p></a-modal>
  </div>
</template>

<script setup>
import { Message } from '@arco-design/web-vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { addRoute, deleteRoute, listNodes, moveNodes, setLeader } from './api.js'
import { KEY, annotations, displayNodes, endpointHost, groupNodes, hasManualLeader, nodeAddress, nodeName, regionName, routeRows } from './model.js'

const router = useRouter(), route = useRoute()
const active = computed(() => route.name === 'routes' ? 'routes' : 'nodes')
const nodes = ref([]), loading = ref(false), busy = ref(false), error = ref(''), selected = ref([])
const groups = computed(() => groupNodes(nodes.value))
const visibleNodes = computed(() => displayNodes(nodes.value))
const routes = computed(() => routeRows(nodes.value))
const moveVisible = ref(false), moveRegion = ref('')
const addVisible = ref(false), newRoute = ref({ region: undefined, cidr: '' })
const wujieBus = globalThis.window?.$wujie?.bus

function internalIP(node) { return (annotations(node)[KEY.forceInternal] || annotations(node)[KEY.internal] || nodeAddress(node, 'InternalIP')).split('/')[0] }
function publicIP(node) { return nodeAddress(node, 'ExternalIP') || endpointHost(annotations(node)[KEY.forceEndpoint]) }
function leaderName(region) { const group = groups.value.find((item) => item.region === region); return group?.leaders.length === 1 ? nodeName(group.leaders[0]) : group?.leaders.length ? '配置冲突' : 'Kilo 自动选举' }
function selectNode(name, checked) { selected.value = checked ? [...new Set([...selected.value, name])] : selected.value.filter((item) => item !== name) }
function selectGroup(group, checked) { for (const node of group.members) selectNode(nodeName(node), checked) }
function openMove() { moveRegion.value = ''; moveVisible.value = true }
function openAdd() { newRoute.value = { region: groups.value[0]?.region, cidr: '' }; addVisible.value = true }

async function refresh() {
  loading.value = true
  try { nodes.value = await listNodes(); error.value = ''; selected.value = selected.value.filter((name) => visibleNodes.value.some((node) => nodeName(node) === name)) }
  catch (failure) { error.value = failure.message }
  finally { loading.value = false }
}

async function mutate(action, success) {
  busy.value = true
  try { await action(); Message.success(success); await refresh(); return true }
  catch (failure) { Message.error(failure.message); await refresh(); return false }
  finally { busy.value = false }
}

async function saveMove() {
  const region = moveRegion.value.trim()
  if (region.length > 63) return Message.error('区域名称不能超过 63 个字符')
  if (await mutate(() => moveNodes(selected.value, region), '区域已更新')) { moveVisible.value = false; selected.value = [] }
}
async function chooseLeader(group, node) { await mutate(() => setLeader(group.region, nodeName(node)), `已将 ${nodeName(node)} 设为 leader`) }
async function saveRoute() {
  if (newRoute.value.region === undefined) return Message.error('请选择区域')
  if (await mutate(() => addRoute(newRoute.value.region, newRoute.value.cidr), '静态路由已添加')) addVisible.value = false
}
async function removeRoute(item) { await mutate(() => deleteRoute(item.region, item.cidr), '静态路由已删除') }
function onRouteChange(target, data) { if (data?.fromSubPanel || typeof target !== 'string') return; router.push(target.startsWith('#') ? target.slice(1) || '/nodes' : target).catch(() => {}) }
onMounted(() => { refresh(); wujieBus?.$on?.('routeChange', onRouteChange) })
onBeforeUnmount(() => wujieBus?.$off?.('routeChange', onRouteChange))
</script>
