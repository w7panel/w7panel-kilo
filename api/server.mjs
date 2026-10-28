import http from 'node:http'
import { spawn } from 'node:child_process'

const host = '127.0.0.1'
const port = Number(process.env.KILO_API_PORT || 8016)
const kubeconfig = process.env.KILO_KUBECONFIG || '/home/afan/workspace/.kube/218.config'
const allowedKeys = new Set(['kilo.squat.ai/location', 'kilo.squat.ai/leader', 'kilo.squat.ai/allowed-location-ips', 'kilo.squat.ai/force-endpoint', 'kilo.squat.ai/force-internal-ip', 'kilo.squat.ai/persistent-keepalive'])

function kubectl(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('kubectl', ['--kubeconfig', kubeconfig, ...args], { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    let output = '', error = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { error += chunk })
    child.on('error', reject)
    child.on('close', (code) => code ? reject(new Error(error.trim() || `kubectl 退出码 ${code}`)) : resolve(output))
    if (input) child.stdin.end(input)
  })
}

async function bodyOf(request) {
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (body.length > 16384) throw new Error('请求体过大')
  }
  return JSON.parse(body)
}

function validPatch(ops) {
  if (!Array.isArray(ops) || ops.length < 2 || ops[0]?.op !== 'test' || ops[0]?.path !== '/metadata/resourceVersion' || typeof ops[0]?.value !== 'string') return false
  return ops.slice(1).every((op) => {
    const path = op?.path?.match(/^\/metadata\/annotations\/(kilo\.squat\.ai~1[^/]+)$/)?.[1]
    const key = path?.replace('~1', '/')
    return allowedKeys.has(key) && (op.op === 'remove' || (op.op === 'add' && typeof op.value === 'string'))
  })
}

function send(response, status, data) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(typeof data === 'string' ? data : JSON.stringify(data))
}

http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`)
    if (request.method === 'GET' && url.pathname === '/health') return send(response, 200, { ok: true })
    const peerMatch = url.pathname.match(/^\/local\/k8s\/apis\/kilo\.squat\.ai\/v1alpha1\/peers(?:\/([a-z0-9](?:[-a-z0-9.]*[a-z0-9])?))?$/)
    if (peerMatch && !url.search) {
      const name = peerMatch[1]
      if (request.method === 'GET') return send(response, 200, await kubectl(name ? ['get', 'peer', name, '-o', 'json'] : ['get', 'peers', '-o', 'json']))
      if (request.method === 'DELETE' && name) return send(response, 200, await kubectl(['delete', 'peer', name, '-o', 'json']))
      if ((request.method === 'POST' && !name) || (request.method === 'PUT' && name)) {
        if (!request.headers['content-type']?.startsWith('application/json')) return send(response, 415, { error: 'JSON content type required' })
        const peer = await bodyOf(request)
        if (peer.apiVersion !== 'kilo.squat.ai/v1alpha1' || peer.kind !== 'Peer' || !peer.metadata?.name || (name && name !== peer.metadata.name)) return send(response, 400, { error: '无效的 Kilo Peer 对象' })
        return send(response, 200, await kubectl([request.method === 'POST' ? 'create' : 'replace', '-f', '-', '-o', 'json'], JSON.stringify(peer)))
      }
      return send(response, 405, { error: 'method not allowed' })
    }
    const match = url.pathname.match(/^\/local\/k8s\/api\/v1\/nodes(?:\/([a-z0-9](?:[-a-z0-9]*[a-z0-9])?))?$/)
    if (!match || url.search) return send(response, 404, { error: 'not found' })
    const name = match[1]
    if (request.method === 'GET') return send(response, 200, await kubectl(name ? ['get', 'node', name, '-o', 'json'] : ['get', 'nodes', '-o', 'json']))
    if (request.method !== 'PATCH' || !name) return send(response, 405, { error: 'method not allowed' })
    if (!request.headers['content-type']?.startsWith('application/json-patch+json')) return send(response, 415, { error: 'JSON Patch content type required' })
    const patch = await bodyOf(request)
    if (!validPatch(patch)) return send(response, 400, { error: '只允许修改 Kilo 节点配置注解' })
    return send(response, 200, await kubectl(['patch', 'node', name, '--type=json', '-p', JSON.stringify(patch), '-o', 'json']))
  } catch (error) { send(response, 500, { error: error.message }) }
}).listen(port, host, () => console.log(`Kilo local API listening on http://${host}:${port}`))
