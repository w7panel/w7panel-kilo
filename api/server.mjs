import http from 'node:http'
import { spawn } from 'node:child_process'

const host = '127.0.0.1'
const port = 8016
const kubeconfig = process.env.KILO_KUBECONFIG || '/home/afan/workspace/.kube/218.config'
const allowedKeys = new Set(['kilo.squat.ai/location', 'kilo.squat.ai/leader', 'kilo.squat.ai/allowed-location-ips'])

function kubectl(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('kubectl', ['--kubeconfig', kubeconfig, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', error = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { error += chunk })
    child.on('error', reject)
    child.on('close', (code) => code ? reject(new Error(error.trim() || `kubectl 退出码 ${code}`)) : resolve(output))
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
    const match = url.pathname.match(/^\/local\/k8s\/api\/v1\/nodes(?:\/([a-z0-9](?:[-a-z0-9]*[a-z0-9])?))?$/)
    if (!match || url.search) return send(response, 404, { error: 'not found' })
    const name = match[1]
    if (request.method === 'GET') return send(response, 200, await kubectl(name ? ['get', 'node', name, '-o', 'json'] : ['get', 'nodes', '-o', 'json']))
    if (request.method !== 'PATCH' || !name) return send(response, 405, { error: 'method not allowed' })
    if (!request.headers['content-type']?.startsWith('application/json-patch+json')) return send(response, 415, { error: 'JSON Patch content type required' })
    const patch = await bodyOf(request)
    if (!validPatch(patch)) return send(response, 400, { error: '只允许修改 Kilo 区域、leader 和静态路由注解' })
    return send(response, 200, await kubectl(['patch', 'node', name, '--type=json', '-p', JSON.stringify(patch), '-o', 'json']))
  } catch (error) { send(response, 500, { error: error.message }) }
}).listen(port, host, () => console.log(`Kilo local API listening on http://${host}:${port}`))
