import { KEY, annotations, displayNodes, hasManualLeader, nodeName, regionName, regionOf, routesOf, validCidr, validEndpoint, validPublicKey } from './model.js'

function proxy() {
  const fn = globalThis.window?.$wujie?.props?.k8sproxy || globalThis.microData?.cd?.k8sproxy
  if (typeof fn === 'function') return fn
  if (import.meta.env?.DEV && !globalThis.window?.__POWERED_BY_WUJIE__ && !globalThis.microData?.cd) {
    return (path, options) => fetch(`/local/k8s${path}`, options)
  }
  throw new Error('W7Panel 未提供 Kubernetes 代理，请在面板中打开应用')
}

async function request(path, options) {
  const response = await proxy()(path, options)
  if (!response.ok) throw new Error((await response.text()) || `Kubernetes 请求失败（${response.status}）`)
  return response.json()
}

export async function listNodes() {
  return (await request('/api/v1/nodes')).items || []
}

const peersPath = '/apis/kilo.squat.ai/v1alpha1/peers'
export async function listPeers() { return (await request(peersPath)).items || [] }

export async function savePeer(peer) {
  const name = peer.metadata?.name?.trim()
  const spec = peer.spec || {}
  if (!name || name.length > 253 || name.split('.').some((part) => !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(part) || part.length > 63)) throw new Error('Peer 名称须为小写字母、数字、点或连字符')
  if (!validPublicKey(spec.publicKey)) throw new Error('请输入有效的 WireGuard 公钥')
  if (!spec.allowedIPs?.length || spec.allowedIPs.some((ip) => !validCidr(ip))) throw new Error('请输入至少一个有效的 Peer 网段')
  if (spec.endpoint) {
    const host = spec.endpoint.dnsOrIP?.dns || spec.endpoint.dnsOrIP?.ip || ''
    if (!validEndpoint(`${host.includes(':') ? `[${host}]` : host}:${spec.endpoint.port}`)) throw new Error('请输入有效的 Peer Endpoint')
  }
  if (!Number.isInteger(spec.persistentKeepalive) || spec.persistentKeepalive < 0) throw new Error('Keepalive 须为非负整数')
  if (spec.presharedKey && !validPublicKey(spec.presharedKey)) throw new Error('预共享密钥须为 32 字节的 Base64 字符串')
  const existing = peer.metadata.resourceVersion
  return request(existing ? `${peersPath}/${encodeURIComponent(name)}` : peersPath, {
    method: existing ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(peer),
  })
}

export async function deletePeer(name) {
  return request(`${peersPath}/${encodeURIComponent(name)}`, { method: 'DELETE' })
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

export async function saveNodeSettings(name, values) {
  const endpoint = values.endpoint.trim(), internal = values.internal.trim(), keepalive = values.keepalive.trim()
  if (endpoint && !validEndpoint(endpoint)) throw new Error('公网 Endpoint 须为 host:端口，例如 example.com:51820')
  if (internal && internal !== '-' && !validCidr(internal)) throw new Error('内网 IP 须为 CIDR，例如 192.168.1.2/32；输入 - 可禁用')
  if (keepalive && (!/^\d+$/.test(keepalive) || Number(keepalive) > 2147483647)) throw new Error('Keepalive 须为非负整数秒数')
  await patchAnnotations(name, {
    [KEY.forceEndpoint]: endpoint || null,
    [KEY.forceInternal]: internal || null,
    [KEY.keepalive]: keepalive || null,
  })
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
    const oldRegion = regionOf(node)
    if (oldRegion === region) continue
    const routes = routeValues(membersOf(nodes, oldRegion))
    if (routesOf(node).length || (hasManualLeader(node) && routes.length)) {
      const hasRemainingNode = membersOf(nodes, oldRegion).some((member) => !names.includes(nodeName(member)))
      const nextStep = hasRemainingNode
        ? '请先把留在原区域的其他节点设为 leader（路由会转移），或到「静态路由」页删除'
        : '该区域没有其他节点可接任 leader；请先到「静态路由」页删除，移动后按需在新区域添加'
      throw new Error(`${name} 在「${regionName(oldRegion)}」区域有静态路由 ${routes.join('、')}。${nextStep}。`)
    }
  }
  for (const name of names) {
    const node = nodes.find((item) => nodeName(item) === name)
    if (regionOf(node) !== region) await patchAnnotations(name, { [KEY.region]: region, ...(hasManualLeader(node) ? { [KEY.leader]: null } : {}) })
  }
}

export async function renameRegion(oldRegion, region) {
  const nodes = await currentGroups()
  const members = membersOf(nodes, oldRegion)
  if (!members.length) throw new Error('区域已不存在，请刷新后重试')
  if (oldRegion === region) return
  if (membersOf(nodes, region).length) throw new Error(`「${regionName(region)}」区域已存在`)
  for (const node of members) await patchAnnotations(nodeName(node), { [KEY.region]: region })
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
