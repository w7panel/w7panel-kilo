export const KEY = {
  key: 'kilo.squat.ai/key',
  region: 'kilo.squat.ai/location',
  leader: 'kilo.squat.ai/leader',
  routes: 'kilo.squat.ai/allowed-location-ips',
  wireguard: 'kilo.squat.ai/wireguard-ip',
  internal: 'kilo.squat.ai/internal-ip',
  forceInternal: 'kilo.squat.ai/force-internal-ip',
  forceEndpoint: 'kilo.squat.ai/force-endpoint',
  endpoint: 'kilo.squat.ai/endpoint',
  keepalive: 'kilo.squat.ai/persistent-keepalive',
}

export const DEFAULT_REGION = ''
export const regionName = (region) => region || '默认'
export const annotations = (node) => node.metadata?.annotations || {}
export const nodeName = (node) => node.metadata?.name || ''
export const regionOf = (node) => annotations(node)[KEY.region] ?? node.metadata?.labels?.['topology.kubernetes.io/region'] ?? DEFAULT_REGION
export const routesOf = (node) => (annotations(node)[KEY.routes] || '').split(',').map((item) => item.trim()).filter(Boolean)
export const hasManualLeader = (node) => Object.hasOwn(annotations(node), KEY.leader)

export function nodeAddress(node, type) {
  return node.status?.addresses?.find((address) => address.type === type)?.address || ''
}

export function endpointHost(endpoint = '') {
  if (endpoint.startsWith('[')) return endpoint.slice(1, endpoint.indexOf(']'))
  return endpoint.slice(0, endpoint.lastIndexOf(':'))
}

export function displayNodes(nodes) {
  return nodes.filter((node) => Boolean(annotations(node)[KEY.key]))
}

export function groupNodes(nodes) {
  const map = new Map()
  for (const node of displayNodes(nodes)) {
    const region = regionOf(node)
    if (!map.has(region)) map.set(region, [])
    map.get(region).push(node)
  }
  return [...map].sort(([a], [b]) => a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, 'zh-CN')).map(([region, members]) => {
    members.sort((a, b) => nodeName(a).localeCompare(nodeName(b)))
    const leaders = members.filter(hasManualLeader)
    const ipNode = leaders.find((node) => annotations(node)[KEY.wireguard]) || members.find((node) => annotations(node)[KEY.wireguard])
    return { region, members, leaders, meshIP: annotations(ipNode || {})[KEY.wireguard]?.split('/')[0] || '' }
  })
}

export function routeRows(nodes) {
  const rows = new Map()
  for (const node of displayNodes(nodes)) {
    const region = regionOf(node)
    for (const cidr of routesOf(node)) {
      const id = JSON.stringify([region, cidr])
      if (!rows.has(id)) rows.set(id, { id, region, cidr })
    }
  }
  return [...rows.values()].sort((a, b) => a.region.localeCompare(b.region, 'zh-CN') || a.cidr.localeCompare(b.cidr))
}

export function validCidr(value) {
  const [address, prefix, extra] = String(value).trim().split('/')
  if (extra !== undefined || !address || !/^\d+$/.test(prefix || '')) return false
  const ipv4 = address.split('.')
  if (ipv4.length === 4 && ipv4.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)) return Number(prefix) <= 32
  try {
    return new URL(`http://[${address}]/`).hostname.startsWith('[') && Number(prefix) <= 128
  } catch { return false }
}

export function validEndpoint(value) {
  const match = String(value).match(/^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?):([0-9]+)$/)
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) return false
  if (match[1].startsWith('[')) {
    try { new URL(`http://${match[1]}/`); return true } catch { return false }
  }
  if (/^[\d.]+$/.test(match[1])) return match[1].split('.').length === 4 && match[1].split('.').every((part) => Number(part) <= 255)
  return !match[1].includes('..')
}

export function validPublicKey(value) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value || '')) return false
  try { return atob(value).length === 32 } catch { return false }
}
