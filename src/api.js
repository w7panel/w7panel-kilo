import { KEY, annotations, displayNodes, hasManualLeader, nodeName, regionOf, routesOf, validCidr } from './model.js'

function proxy() {
  const fn = globalThis.window?.$wujie?.props?.k8sproxy || globalThis.microData?.cd?.k8sproxy
  if (typeof fn !== 'function') throw new Error('W7Panel 未提供 Kubernetes 代理，请在面板中打开应用')
  return fn
}

async function request(path, options) {
  const response = await proxy()(path, options)
  if (!response.ok) throw new Error((await response.text()) || `Kubernetes 请求失败（${response.status}）`)
  return response.json()
}

export async function listNodes() {
  return (await request('/api/v1/nodes')).items || []
}

async function getNode(name) {
  return request(`/api/v1/nodes/${encodeURIComponent(name)}`)
}

async function patchAnnotations(name, changes) {
  const node = await getNode(name)
  const before = annotations(node)
  const ops = [{ op: 'test', path: '/metadata/resourceVersion', value: node.metadata.resourceVersion }]
  if (!node.metadata.annotations) ops.push({ op: 'add', path: '/metadata/annotations', value: {} })
  for (const [key, value] of Object.entries(changes)) {
    const path = `/metadata/annotations/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`
    if (value === null) {
      if (Object.hasOwn(before, key)) ops.push({ op: 'remove', path })
    } else ops.push({ op: 'add', path, value })
  }
  if (ops.length === 1) return
  try {
    await request(`/api/v1/nodes/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify(ops),
    })
  } catch (error) { throw new Error(`${name}：${error.message}`) }
}

async function currentGroups() {
  return displayNodes(await listNodes())
}

function membersOf(nodes, region) {
  return nodes.filter((node) => regionOf(node) === region)
}

function routeValues(nodes) {
  return [...new Set(nodes.flatMap(routesOf))]
}

export async function moveNodes(names, region) {
  const nodes = await currentGroups()
  for (const name of names) {
    const node = nodes.find((item) => nodeName(item) === name)
    if (!node) throw new Error(`节点 ${name} 已不在 Kilo 组网中`)
    if (regionOf(node) === region) continue
    if (routesOf(node).length) throw new Error(`${name} 持有原区域静态路由；请先删除这些路由或将区域 leader 切换到其他节点`)
    if (hasManualLeader(node) && routeValues(membersOf(nodes, regionOf(node))).length) {
      throw new Error(`${name} 是原区域 leader，且该区域有静态路由；请先更换原区域 leader`)
    }
  }
  for (const name of names) {
    const node = nodes.find((item) => nodeName(item) === name)
    if (regionOf(node) !== region) await patchAnnotations(name, { [KEY.region]: region, ...(hasManualLeader(node) ? { [KEY.leader]: null } : {}) })
  }
}

export async function setLeader(region, name) {
  const nodes = await currentGroups()
  const members = membersOf(nodes, region)
  if (!members.some((node) => nodeName(node) === name)) throw new Error('目标节点不在该区域，请刷新后重试')
  const routes = routeValues(members)
  const target = members.find((node) => nodeName(node) === name)
  const merged = [...new Set([...routesOf(target), ...routes])]
  if (routes.length) await patchAnnotations(name, { [KEY.routes]: merged.join(',') })
  await patchAnnotations(name, { [KEY.leader]: 'true' })
  for (const node of members) {
    if (nodeName(node) !== name && hasManualLeader(node)) await patchAnnotations(nodeName(node), { [KEY.leader]: null })
  }
  for (const node of members) {
    if (nodeName(node) !== name && routesOf(node).length) await patchAnnotations(nodeName(node), { [KEY.routes]: null })
  }
}

export async function addRoute(region, cidr) {
  const value = cidr.trim()
  if (!validCidr(value)) throw new Error('请输入有效的 IP/CIDR，例如 10.0.0.0/24')
  const members = membersOf(await currentGroups(), region)
  const leaders = members.filter(hasManualLeader)
  if (leaders.length !== 1) throw new Error('请先为该区域指定唯一的 leader')
  if (routeValues(members).includes(value)) throw new Error('该区域已存在这条静态路由')
  const leader = leaders[0]
  await patchAnnotations(nodeName(leader), { [KEY.routes]: [...routesOf(leader), value].join(',') })
}

export async function deleteRoute(region, cidr) {
  const members = membersOf(await currentGroups(), region)
  for (const node of members) {
    const existing = routesOf(node)
    if (!existing.includes(cidr)) continue
    const remaining = existing.filter((item) => item !== cidr)
    await patchAnnotations(nodeName(node), { [KEY.routes]: remaining.length ? remaining.join(',') : null })
  }
}
