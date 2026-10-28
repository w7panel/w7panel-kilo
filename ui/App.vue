<template>
  <div class="app-shell">
    <main class="workspace">
      <div class="page-heading">
        <div><h1>组网管理</h1><p class="intro">查看节点和区域，管理路由、外部 Peer 与组网连接。已加入 {{ visibleNodes.length }} 个节点。</p></div>
        <a-button :loading="loading" @click="refresh"><template #icon><icon-refresh /></template>刷新</a-button>
      </div>

      <nav class="tabs" aria-label="组网页面">
        <router-link to="/nodes" :class="{ active: active === 'nodes' }">节点</router-link>
        <router-link to="/routes" :class="{ active: active === 'routes' }">静态路由</router-link>
        <router-link to="/peers" :class="{ active: active === 'peers' }">外部 Peer</router-link>
        <router-link to="/topology" :class="{ active: active === 'topology' }">拓扑</router-link>
      </nav>

      <a-alert v-if="error" type="error" class="load-error" :show-icon="true">{{ error }}</a-alert>

      <section v-if="active === 'nodes'" class="tab-content">
        <div class="section-head"><div><h2>节点区域</h2><p>区域内节点共用一个组网入口；未设置区域的节点归入“默认”。</p></div><a-button :disabled="!selected.length" @click="openMove">设置区域<span v-if="selected.length">（{{ selected.length }}）</span></a-button></div>
        <div v-if="!groups.length && !loading" class="empty-state">尚无加入 Kilo 组网的节点。请确认 Kilo 已在集群节点上运行。</div>
        <div v-for="group in groups" :key="group.region" class="region-card">
          <div class="region-head"><div class="region-title"><span class="region-dot"></span><div><span class="region-kicker">区域 · {{ group.members.length }} 个节点</span><h3>{{ regionName(group.region) }}</h3></div></div><div class="region-leader"><span>区域 leader</span><b>{{ group.leaders.length === 1 ? nodeName(group.leaders[0]) : group.leaders.length ? '配置冲突' : 'Kilo 自动选举' }}</b></div></div>
          <div class="table-scroll"><table class="data-table"><thead><tr><th class="check-col"><a-checkbox :model-value="group.members.every((node) => selected.includes(nodeName(node)))" @change="(checked) => selectGroup(group, checked)" :aria-label="`选择 ${regionName(group.region)} 区域全部节点`" /></th><th>节点</th><th>内网 IP</th><th>组网 IP</th><th>公网地址</th><th>操作</th></tr></thead><tbody>
            <tr v-for="node in group.members" :key="nodeName(node)"><td><a-checkbox :model-value="selected.includes(nodeName(node))" @change="(checked) => selectNode(nodeName(node), checked)" :aria-label="`选择节点 ${nodeName(node)}`" /></td><td class="node-name"><span>{{ nodeName(node) }}</span><em v-if="hasManualLeader(node)">LEADER</em></td><td class="mono">{{ internalIP(node) || '—' }}</td><td class="mono">{{ group.meshIP || '—' }}<small v-if="group.meshIP" class="shared-label">区域共享</small></td><td class="mono">{{ publicIP(node) || '—' }}</td><td><a-button size="small" type="text" :disabled="busy || (group.leaders.length === 1 && nodeName(group.leaders[0]) === nodeName(node))" @click="chooseLeader(group, node)">设为 leader</a-button><a-button size="small" type="text" :disabled="busy" @click="openSettings(node)">连接设置</a-button></td></tr>
          </tbody></table></div>
        </div>
      </section>

      <section v-else-if="active === 'routes'" class="tab-content">
        <div class="section-head"><div><h2>静态路由</h2><p>目标网段由所选区域对外提供，配置保存在该区域 leader 上。</p></div><a-button type="primary" @click="openAdd">添加静态路由</a-button></div>
        <div class="route-card"><div v-if="!routes.length && !loading" class="empty-state">暂无静态路由。先在节点页为区域指定 leader，再添加目标网段。</div><div v-else class="table-scroll"><table class="data-table"><thead><tr><th>区域</th><th>目标网段</th><th>区域 leader</th><th>操作</th></tr></thead><tbody><tr v-for="routeItem in routes" :key="routeItem.id"><td>{{ regionName(routeItem.region) }}</td><td class="mono">{{ routeItem.cidr }}</td><td>{{ leaderName(routeItem.region) }}</td><td><a-popconfirm content="确定删除这条静态路由？" @ok="removeRoute(routeItem)"><a-button type="text" status="danger" size="small" :disabled="busy">删除</a-button></a-popconfirm></td></tr></tbody></table></div></div>
      </section>

      <section v-else-if="active === 'peers'" class="tab-content">
        <div class="section-head"><div><h2>外部 Peer</h2><p>为外部设备声明公钥和它对外提供的网段；接入端需自行配置 WireGuard。</p></div><a-button type="primary" @click="openPeer()">添加 Peer</a-button></div>
        <div class="route-card"><div v-if="!peers.length && !loading" class="empty-state">暂无外部 Peer。添加后，Kilo 会将其网段加入组网。</div><div v-else class="table-scroll"><table class="data-table"><thead><tr><th>名称</th><th>对外提供的网段</th><th>Endpoint</th><th>Keepalive</th><th>操作</th></tr></thead><tbody><tr v-for="peer in peers" :key="peer.metadata.name"><td class="node-name">{{ peer.metadata.name }}</td><td class="mono">{{ peer.spec.allowedIPs.join(', ') }}</td><td class="mono">{{ peerEndpoint(peer) || '—' }}</td><td>{{ peer.spec.persistentKeepalive || '—' }}</td><td><a-button type="text" size="small" :disabled="busy" @click="openPeer(peer)">编辑</a-button><a-popconfirm content="确定删除这个 Peer？外部连接会中断。" @ok="removePeer(peer)"><a-button type="text" status="danger" size="small" :disabled="busy">删除</a-button></a-popconfirm></td></tr></tbody></table></div></div>
      </section>

      <section v-else class="tab-content">
        <div class="section-head"><div><h2>区域拓扑</h2><p>区域、节点与连接关系来自当前配置；连线不代表实时隧道状态。</p></div></div>
        <div v-if="!groups.length && !loading" class="empty-state">暂无组网节点。</div>
        <figure v-if="groups.length" class="topology-figure">
          <figcaption class="topology-legend"><span><i class="legend-mesh"></i>区域间关系</span><span><i class="legend-member"></i>区域成员</span><span>依据配置绘制 · 非实时监测</span></figcaption>
          <div class="topology-scroll">
            <svg class="topology-canvas" :width="topology.width" :height="topology.height" :viewBox="`0 0 ${topology.width} ${topology.height}`" role="img" :aria-label="`${groups.length} 个区域、${visibleNodes.length} 个节点的 Kilo 配置拓扑图`">
              <defs><pattern id="topology-dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#dce7ed" /></pattern></defs>
              <rect width="100%" height="100%" fill="url(#topology-dots)" />
              <path v-for="link in topology.links" :key="link.key" :d="link.path" class="mesh-link" />
              <g v-for="region in topology.regions" :key="region.region">
                <path v-for="member in region.nodes" :key="nodeName(member.node)" :d="`M ${region.x} ${region.y + 49} V ${member.y - 24}`" class="member-link" />
                <rect :x="region.x - 130" :y="region.y - 50" width="260" height="100" rx="13" class="topology-region" />
                <circle :cx="region.x - 107" :cy="region.y - 25" r="5" class="region-signal" />
                <text :x="region.x - 93" :y="region.y - 20" class="region-caption">区域 · {{ region.members.length }} 个节点</text>
                <text :x="region.x - 107" :y="region.y + 9" class="region-name"><title>{{ regionName(region.region) }}</title>{{ shortName(regionName(region.region), 17) }}</text>
                <text :x="region.x - 107" :y="region.y + 32" class="region-meta"><title>{{ leaderName(region.region) }}</title>入口 {{ shortName(leaderName(region.region), 15) }} · {{ region.meshIP || '组网 IP 未就绪' }}</text>
                <g v-for="member in region.nodes" :key="nodeName(member.node)">
                  <rect :x="region.x - 130" :y="member.y - 24" width="260" height="48" rx="8" class="topology-node" />
                  <circle :cx="region.x - 108" :cy="member.y" r="5" :class="hasManualLeader(member.node) ? 'leader-signal' : 'node-signal'" />
                  <text :x="region.x - 94" :y="member.y - 2" class="topology-node-name"><title>{{ nodeName(member.node) }}</title>{{ shortName(nodeName(member.node), 18) }}</text>
                  <text :x="region.x - 94" :y="member.y + 14" class="topology-node-ip">{{ internalIP(member.node) || '内网 IP 未设置' }}<tspan v-if="hasManualLeader(member.node)" class="topology-leader-tag"> · LEADER</tspan></text>
                </g>
              </g>
            </svg>
          </div>
        </figure>
      </section>
    </main>

    <a-modal v-model:visible="moveVisible" title="设置节点区域" :ok-loading="busy" @ok="saveMove" @cancel="moveVisible = false"><p class="modal-hint">将 {{ selected.length }} 个节点划入指定区域。输入现有或新的区域名称。</p><a-input v-model="moveRegion" placeholder="区域名称；留空表示默认区域" :max-length="63" /><div class="region-choices"><a-tag v-for="group in groups" :key="group.region" class="choice-tag" @click="moveRegion = group.region">{{ regionName(group.region) }}</a-tag></div></a-modal>
    <a-modal v-model:visible="addVisible" title="添加静态路由" :ok-loading="busy" @ok="saveRoute" @cancel="addVisible = false"><a-form :model="newRoute" layout="vertical"><a-form-item label="区域"><a-select v-model="newRoute.region" placeholder="选择区域"><a-option v-for="group in groups" :key="group.region || 'default'" :value="group.region">{{ regionName(group.region) }}</a-option></a-select></a-form-item><a-form-item label="目标网段"><a-input v-model="newRoute.cidr" placeholder="例如 10.0.0.0/24" /></a-form-item></a-form><p class="modal-hint">该网段将从其他区域通过 Kilo 路由到所选区域。</p></a-modal>
    <a-modal v-model:visible="settingsVisible" :title="`${settingsName} · 连接设置`" :ok-loading="busy" @ok="submitSettings"><a-form :model="settings" layout="vertical"><a-form-item label="公网 Endpoint"><a-input v-model="settings.endpoint" placeholder="例如 example.com:51820；留空自动检测" /></a-form-item><a-form-item label="内网 IP"><a-input v-model="settings.internal" placeholder="例如 192.168.1.2/32；输入 - 可禁用" /></a-form-item><a-form-item label="Keepalive（秒）"><a-input v-model="settings.keepalive" placeholder="NAT 后节点可设 25；留空使用默认值" /></a-form-item></a-form></a-modal>
    <a-modal v-model:visible="peerVisible" :title="peerEditing ? '编辑 Peer' : '添加 Peer'" :ok-loading="busy" @ok="submitPeer"><a-form :model="peerDraft" layout="vertical"><a-form-item label="名称"><a-input v-model="peerDraft.name" :disabled="peerEditing" placeholder="例如 branch-gateway" /></a-form-item><a-form-item label="WireGuard 公钥"><a-input v-model="peerDraft.publicKey" placeholder="44 位 Base64 公钥" /></a-form-item><a-form-item label="对外提供的网段"><a-textarea v-model="peerDraft.allowedIPs" placeholder="每行一个 CIDR，例如 10.5.0.1/32" :auto-size="{ minRows: 2, maxRows: 5 }" /></a-form-item><a-form-item label="Endpoint（可选）"><a-input v-model="peerDraft.endpoint" placeholder="例如 gateway.example.com:51820" /></a-form-item><a-form-item label="Keepalive（秒）"><a-input v-model="peerDraft.keepalive" placeholder="0 表示关闭" /></a-form-item><a-form-item label="预共享密钥（可选）"><a-input-password v-model="peerDraft.presharedKey" placeholder="留空表示不使用" /></a-form-item></a-form><p class="modal-hint">保存前确认网段不会与集群或其他 Peer 重叠。</p></a-modal>
  </div>
</template>

<script setup>
import { Message } from '@arco-design/web-vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { addRoute, deletePeer, deleteRoute, listNodes, listPeers, moveNodes, saveNodeSettings, savePeer, setLeader } from './api.js'
import { KEY, annotations, displayNodes, endpointHost, groupNodes, hasManualLeader, nodeAddress, nodeName, regionName, routeRows } from './model.js'
import { topologyLayout } from './topology.js'

const router = useRouter(), route = useRoute()
const active = computed(() => ['routes', 'peers', 'topology'].includes(route.name) ? route.name : 'nodes')
const nodes = ref([]), loading = ref(false), busy = ref(false), error = ref(''), selected = ref([])
const peers = ref([])
const groups = computed(() => groupNodes(nodes.value))
const topology = computed(() => topologyLayout(groups.value))
const visibleNodes = computed(() => displayNodes(nodes.value))
const routes = computed(() => routeRows(nodes.value))
const moveVisible = ref(false), moveRegion = ref('')
const addVisible = ref(false), newRoute = ref({ region: undefined, cidr: '' })
const settingsVisible = ref(false), settingsName = ref(''), settings = ref({ endpoint: '', internal: '', keepalive: '' })
const peerVisible = ref(false), peerSource = ref(null), peerDraft = ref({ name: '', publicKey: '', allowedIPs: '', endpoint: '', keepalive: '0', presharedKey: '' })
const peerEditing = computed(() => Boolean(peerSource.value))
const wujieBus = globalThis.window?.$wujie?.bus

function internalIP(node) { return (annotations(node)[KEY.forceInternal] || annotations(node)[KEY.internal] || nodeAddress(node, 'InternalIP')).split('/')[0] }
function publicIP(node) { return endpointHost(annotations(node)[KEY.forceEndpoint]) || nodeAddress(node, 'ExternalIP') }
function peerEndpoint(peer) { const endpoint = peer.spec.endpoint; if (!endpoint) return ''; const host = endpoint.dnsOrIP?.dns || endpoint.dnsOrIP?.ip || ''; return `${host.includes(':') ? `[${host}]` : host}:${endpoint.port}` }
function leaderName(region) { const group = groups.value.find((item) => item.region === region); return group?.leaders.length === 1 ? nodeName(group.leaders[0]) : group?.leaders.length ? '配置冲突' : 'Kilo 自动选举' }
function shortName(value, length) { return value.length > length ? `${value.slice(0, length - 1)}…` : value }
function selectNode(name, checked) { selected.value = checked ? [...new Set([...selected.value, name])] : selected.value.filter((item) => item !== name) }
function selectGroup(group, checked) { for (const node of group.members) selectNode(nodeName(node), checked) }
function openMove() { moveRegion.value = ''; moveVisible.value = true }
function openAdd() { newRoute.value = { region: groups.value[0]?.region, cidr: '' }; addVisible.value = true }
function openSettings(node) { settingsName.value = nodeName(node); const data = annotations(node); settings.value = { endpoint: data[KEY.forceEndpoint] || '', internal: data[KEY.forceInternal] || '', keepalive: data[KEY.keepalive] || '' }; settingsVisible.value = true }
function openPeer(peer) {
  peerSource.value = peer || null
  peerDraft.value = peer ? { name: peer.metadata.name, publicKey: peer.spec.publicKey, allowedIPs: peer.spec.allowedIPs.join('\n'), endpoint: peerEndpoint(peer), keepalive: String(peer.spec.persistentKeepalive || 0), presharedKey: peer.spec.presharedKey || '' } : { name: '', publicKey: '', allowedIPs: '', endpoint: '', keepalive: '0', presharedKey: '' }
  peerVisible.value = true
}

async function refresh() {
  loading.value = true
  try { nodes.value = await listNodes(); if (active.value === 'peers') peers.value = await listPeers(); error.value = ''; selected.value = selected.value.filter((name) => visibleNodes.value.some((node) => nodeName(node) === name)) }
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
async function submitSettings() { if (await mutate(() => saveNodeSettings(settingsName.value, settings.value), '节点连接设置已保存')) settingsVisible.value = false }
async function submitPeer() {
  const form = peerDraft.value
  const endpoint = form.endpoint.trim()
  const host = endpoint.slice(0, endpoint.lastIndexOf(':')).replace(/^\[|\]$/g, '')
  const port = Number(endpoint.slice(endpoint.lastIndexOf(':') + 1))
  const spec = { publicKey: form.publicKey.trim(), allowedIPs: form.allowedIPs.split(/[\n,]/).map((ip) => ip.trim()).filter(Boolean), persistentKeepalive: Number(form.keepalive) }
  if (endpoint) spec.endpoint = { dnsOrIP: /[:]/.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host) ? { ip: host } : { dns: host }, port }
  if (form.presharedKey.trim()) spec.presharedKey = form.presharedKey.trim()
  const peer = { apiVersion: 'kilo.squat.ai/v1alpha1', kind: 'Peer', metadata: peerSource.value?.metadata || { name: form.name.trim() }, spec }
  if (await mutate(() => savePeer(peer), 'Peer 已保存')) peerVisible.value = false
}
async function removePeer(peer) { await mutate(() => deletePeer(peer.metadata.name), 'Peer 已删除') }
function onRouteChange(target, data) { if (data?.fromSubPanel || typeof target !== 'string') return; router.push(target.startsWith('#') ? target.slice(1) || '/nodes' : target).catch(() => {}) }
onMounted(() => { refresh(); wujieBus?.$on?.('routeChange', onRouteChange) })
watch(active, refresh)
onBeforeUnmount(() => wujieBus?.$off?.('routeChange', onRouteChange))
</script>
