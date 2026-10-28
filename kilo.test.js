import test from 'node:test'
import assert from 'node:assert/strict'
import { addRoute, deleteRoute, moveNodes, setLeader } from './src/api.js'
import { KEY, groupNodes, routeRows, validCidr } from './src/model.js'

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

test('route change moves all CIDRs to new leader and preserves unrelated annotations', async () => {
  const nodes = fakeCluster([node('a', 'east', { [KEY.leader]: '', [KEY.routes]: '10.0.0.0/24,10.2.0.0/24', keep: 'yes' }), node('b', 'east')])
  await setLeader('east', 'b')
  assert.equal(nodes[0].metadata.annotations[KEY.leader], undefined)
  assert.equal(nodes[0].metadata.annotations[KEY.routes], undefined)
  assert.equal(nodes[0].metadata.annotations.keep, 'yes')
  assert.equal(nodes[1].metadata.annotations[KEY.routes], '10.0.0.0/24,10.2.0.0/24')
  assert.equal(nodes[1].metadata.annotations[KEY.leader], 'true')
})

test('partial leader change keeps route on the new leader when old node update fails', async () => {
  const nodes = fakeCluster([node('a', 'east', { [KEY.leader]: 'true', [KEY.routes]: '10.0.0.0/24' }), node('b', 'east')], 'a')
  await assert.rejects(setLeader('east', 'b'), /a：模拟写入失败/)
  assert.equal(nodes[1].metadata.annotations[KEY.routes], '10.0.0.0/24')
})

test('adds and deletes one CIDR while retaining other routes', async () => {
  const nodes = fakeCluster([node('a', 'east', { [KEY.leader]: 'true', [KEY.routes]: '10.0.0.0/24' })])
  await addRoute('east', '10.2.0.0/24')
  assert.equal(routeRows(nodes).length, 2)
  await deleteRoute('east', '10.0.0.0/24')
  assert.equal(nodes[0].metadata.annotations[KEY.routes], '10.2.0.0/24')
})

test('blocks moving a route owning leader to another region', async () => {
  fakeCluster([node('a', 'east', { [KEY.leader]: 'true', [KEY.routes]: '10.0.0.0/24' }), node('b', 'east')])
  await assert.rejects(moveNodes(['a'], 'west'), /持有原区域静态路由/)
})

test('blocks moving a route owning non-leader to another region', async () => {
  fakeCluster([node('a', 'east', { [KEY.leader]: 'true' }), node('b', 'east', { [KEY.routes]: '10.0.0.0/24' })])
  await assert.rejects(moveNodes(['b'], 'west'), /持有原区域静态路由/)
})

test('validates IPv4 and IPv6 CIDRs', () => {
  assert.equal(validCidr('10.0.0.0/24'), true)
  assert.equal(validCidr('2001:db8::/64'), true)
  assert.equal(validCidr('10.0.0.999/24'), false)
  assert.equal(validCidr('10.0.0.0/33'), false)
})
