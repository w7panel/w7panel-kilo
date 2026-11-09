import test from 'node:test'
import assert from 'node:assert/strict'
import { addRoute, deleteRoute, moveNodes, renameRegion, saveNodeSettings, savePeer, setLeader } from './ui/api.js'
import { KEY, groupNodes, routeRows, validCidr, validEndpoint, validPublicKey } from './ui/model.js'
import { topologyLayout } from './ui/topology.js'

function node(name, region, extra = {}) {
  return { metadata: { name, resourceVersion: '1', annotations: { [KEY.key]: `key-${name}`, [KEY.region]: region, ...extra } }, status: { addresses: [{ type: 'InternalIP', address: '10.1.0.1' }] } }
}

function fakeCluster(items, failPatchName) {
  const nodes = structuredClone(items)
  globalThis.window = { $wujie: { props: { k8sproxy: async (path, options = {}) => {
    if (path === '/api/v1/nodes') return Response.json({ items: nodes })
    const name = decodeURIComponent(path.split('/').at(-1))
    const target = nodes.find((item) => item.metadata.name === name)
    if (!target) return new Response('Not Found', { status: 404 })
    if (options.method !== 'PATCH') return Response.json(target)
    if (name === failPatchName) return new Response('模拟写入失败', { status: 500 })
    const ops = JSON.parse(options.body)
    if (ops[0].value !== target.metadata.resourceVersion) return new Response('Conflict', { status: 409 })
    for (const op of ops.slice(1)) {
      if (op.path === '/metadata/annotations') { target.metadata.annotations = {}; continue }
      const key = op.path.split('/').at(-1).replaceAll('~1', '/').replaceAll('~0', '~')
      if (op.op === 'remove') delete target.metadata.annotations[key]
      else target.metadata.annotations[key] = op.value
    }
    target.metadata.resourceVersion = String(Number(target.metadata.resourceVersion) + 1)
    return Response.json(target)
  } } } }
  return nodes
}

test('groups Kilo nodes by effective region and shares leader IP', () => {
  const nodes = [node('a', 'east', { [KEY.leader]: 'true', [KEY.wireguard]: '10.4.0.1/16' }), node('b', 'east'), { metadata: { name: 'other', annotations: {} } }]
  const group = groupNodes(nodes)[0]
  assert.equal(group.region, 'east')
  assert.equal(group.meshIP, '10.4.0.1')
  assert.equal(group.members.length, 2)
})

test('explicit location overrides topology region and missing region is default', () => {
  const labeled = node('a', 'custom')
  labeled.metadata.labels = { 'topology.kubernetes.io/region': 'cloud' }
  const unnamed = node('b', '')
  delete unnamed.metadata.annotations[KEY.region]
  assert.deepEqual(groupNodes([labeled, unnamed]).map((group) => group.region), ['', 'custom'])
})

test('topology connects regions and keeps every member below its region', () => {
  const groups = groupNodes([node('a', 'east', { [KEY.leader]: 'true' }), node('b', 'east'), node('c', 'west')])
  const graph = topologyLayout(groups)
  assert.equal(graph.links.length, 1)
  assert.equal(graph.width, 680)
  assert.equal(graph.regions[0].x, 170)
  assert.equal(graph.regions[0].nodes.length, 2)
  assert.ok(graph.regions[0].nodes[0].y > graph.regions[0].y)
  assert.ok(graph.regions[1].x - graph.regions[0].x >= 300)
})

test('topology shows each static route in its region without overlapping members', () => {
  const nodes = [node('a', 'east', { [KEY.routes]: '10.0.0.15/32,10.0.0.17/32' }), node('b', 'west', { [KEY.routes]: '10.0.64.16/32' })]
  const graph = topologyLayout(groupNodes(nodes), routeRows(nodes))
  assert.deepEqual(graph.regions.map((region) => region.routes.map((route) => route.cidr)), [['10.0.0.15/32', '10.0.0.17/32'], ['10.0.64.16/32']])
  assert.ok(graph.regions[0].nodes[0].y - 24 > graph.regions[0].y + 50 + graph.regions[0].routes.length * 18)
})

test('route change moves all CIDRs to new leader and preserves unrelated annotations', async () => {
  const nodes = fakeCluster([node('a', 'east', { [KEY.leader]: '', [KEY.routes]: '10.0.0.0/24,10.2.0.0/24', keep: 'yes' }), node('b', 'east', { [KEY.forceEndpoint]: '203.0.113.2:51820' })])
  await setLeader('east', 'b')
  assert.equal(nodes[0].metadata.annotations[KEY.leader], undefined)
  assert.equal(nodes[0].metadata.annotations[KEY.routes], undefined)
  assert.equal(nodes[0].metadata.annotations.keep, 'yes')
  assert.equal(nodes[1].metadata.annotations[KEY.routes], '10.0.0.0/24,10.2.0.0/24')
  assert.equal(nodes[1].metadata.annotations[KEY.leader], 'true')
})

test('partial leader change keeps route on the new leader when old node update fails', async () => {
  const nodes = fakeCluster([node('a', 'east', { [KEY.leader]: 'true', [KEY.routes]: '10.0.0.0/24' }), node('b', 'east', { [KEY.forceEndpoint]: '203.0.113.2:51820' })], 'a')
  await assert.rejects(setLeader('east', 'b'), /a：模拟写入失败/)
  assert.equal(nodes[1].metadata.annotations[KEY.routes], '10.0.0.0/24')
})

test('leader change requires a forced endpoint before moving routes', async () => {
  const nodes = fakeCluster([node('a', 'east', { [KEY.leader]: 'true', [KEY.routes]: '10.0.0.0/24' }), node('b', 'east', { [KEY.endpoint]: '203.0.113.2:51820' })])
  await assert.rejects(setLeader('east', 'b'), /请先在连接设置中，将端点IP指定为该节点的公网IP/)
  assert.equal(nodes[0].metadata.annotations[KEY.leader], 'true')
  assert.equal(nodes[0].metadata.annotations[KEY.routes], '10.0.0.0/24')
  assert.equal(nodes[1].metadata.annotations[KEY.leader], undefined)
  assert.equal(nodes[1].metadata.annotations[KEY.routes], undefined)
})

test('adds and deletes one CIDR while retaining other routes', async () => {
  const nodes = fakeCluster([node('a', 'east', { [KEY.leader]: 'true', [KEY.routes]: '10.0.0.0/24' })])
  await addRoute('east', '10.2.0.0/24')
  assert.equal(routeRows(nodes).length, 2)
  await deleteRoute('east', '10.0.0.0/24')
  assert.equal(nodes[0].metadata.annotations[KEY.routes], '10.2.0.0/24')
})

test('renames a whole region while retaining its leader and static routes', async () => {
  const nodes = fakeCluster([node('a', 'east', { [KEY.leader]: 'true', [KEY.routes]: '10.0.0.0/24' }), node('b', 'east'), node('c', 'west')])
  await renameRegion('east', 'north')
  assert.deepEqual(nodes.slice(0, 2).map((item) => item.metadata.annotations[KEY.region]), ['north', 'north'])
  assert.equal(nodes[0].metadata.annotations[KEY.leader], 'true')
  assert.equal(nodes[0].metadata.annotations[KEY.routes], '10.0.0.0/24')
  await assert.rejects(renameRegion('north', 'west'), /区域已存在/)
  assert.equal(nodes[2].metadata.annotations[KEY.region], 'west')
})

test('blocks moving a route owning leader to another region', async () => {
  fakeCluster([node('a', 'east', { [KEY.leader]: 'true', [KEY.routes]: '10.0.0.0/24' }), node('b', 'east')])
  await assert.rejects(moveNodes(['a'], 'west'), /a 在「east」区域有静态路由 10\.0\.0\.0\/24。请先把留在原区域的其他节点设为 leader/)
})

test('blocks moving a route owning non-leader to another region', async () => {
  fakeCluster([node('a', 'east', { [KEY.leader]: 'true' }), node('b', 'east', { [KEY.routes]: '10.0.0.0/24' })])
  await assert.rejects(moveNodes(['b'], 'west'), /静态路由 10\.0\.0\.0\/24。请先把留在原区域的其他节点设为 leader/)
})

test('explains that a sole route owner must remove routes before moving', async () => {
  fakeCluster([node('agent1', 'taiyuan', { [KEY.leader]: 'true', [KEY.routes]: '172.16.1.3/32' })])
  await assert.rejects(moveNodes(['agent1'], 'shanghai'), /agent1 在「taiyuan」区域有静态路由 172\.16\.1\.3\/32。该区域没有其他节点可接任 leader；请先到「静态路由」页删除/)
})

test('validates IPv4 and IPv6 CIDRs', () => {
  assert.equal(validCidr('10.0.0.0/24'), true)
  assert.equal(validCidr('2001:db8::/64'), true)
  assert.equal(validCidr('10.0.0.999/24'), false)
  assert.equal(validCidr('10.0.0.0/33'), false)
})

test('node connection settings update only editable Kilo annotations', async () => {
  const nodes = fakeCluster([node('a', 'east', { [KEY.key]: 'keep-this', [KEY.forceEndpoint]: 'old.example:51820', [KEY.endpoint]: 'old.example:51820' })])
  await saveNodeSettings('a', { endpoint: 'new.example:51821', internal: '-', keepalive: '25' })
  assert.equal(nodes[0].metadata.annotations[KEY.forceEndpoint], 'new.example:51821')
  assert.equal(nodes[0].metadata.annotations[KEY.endpoint], undefined)
  assert.equal(nodes[0].metadata.annotations[KEY.forceInternal], '-')
  assert.equal(nodes[0].metadata.annotations[KEY.keepalive], '25')
  assert.equal(nodes[0].metadata.annotations[KEY.key], 'keep-this')
  await assert.rejects(saveNodeSettings('a', { endpoint: 'bad', internal: '', keepalive: '' }), /端点 IP/)
})

test('validates endpoints and WireGuard keys', () => {
  assert.equal(validEndpoint('example.com:51820'), true)
  assert.equal(validEndpoint('[2001:db8::1]:51820'), true)
  assert.equal(validEndpoint('example.com:65536'), false)
  assert.equal(validPublicKey(Buffer.alloc(32, 1).toString('base64')), true)
  assert.equal(validPublicKey('invalid'), false)
})

test('Peer creation uses the Kilo CRD endpoint and validates CIDRs', async () => {
  const calls = []
  globalThis.window = { $wujie: { props: { k8sproxy: async (path, options) => { calls.push({ path, options }); return Response.json({}) } } } }
  const peer = { apiVersion: 'kilo.squat.ai/v1alpha1', kind: 'Peer', metadata: { name: 'branch-gateway' }, spec: { publicKey: Buffer.alloc(32, 1).toString('base64'), allowedIPs: ['10.5.0.1/32'], endpoint: { dnsOrIP: { dns: 'gateway.example.com' }, port: 51820 }, persistentKeepalive: 25 } }
  await savePeer(peer)
  assert.equal(calls[0].path, '/apis/kilo.squat.ai/v1alpha1/peers')
  assert.equal(calls[0].options.method, 'POST')
  await assert.rejects(savePeer({ ...peer, spec: { ...peer.spec, allowedIPs: ['bad'] } }), /网段/)
})
