#!/usr/bin/env node
/**
 * Fence-contract preflight for free-model-gateway (offline, no upstream calls).
 *
 * What it pins
 * ============
 *
 * The OFM standalone service has two HTTP surfaces with different trust
 * shapes, and the reverse proxy's entire job is to satisfy them:
 *
 *   /v1/*              — src/forward.js: Bearer key only, no Host/Origin fence.
 *   management surface  — packages/standalone/management.mjs runs
 *                         structuralRejection() (src/trust.js) BEFORE its own
 *                         auth: Host must be loopback; Origin/Referer, when
 *                         present, must match that Host exactly.
 *
 * This script starts the real service (—-no-refresh, so it never dials any
 * upstream) behind a tiny reference proxy that implements the same rule
 * table as nginx/ofm.conf:
 *
 *   /v1/*            -> forward untouched
 *   everything else  -> Host: 127.0.0.1:18900, Origin/Referer/Sec-Fetch-Site stripped
 *
 * and then runs the nine assertions from docs/plans/2026-10-11-free-model-gateway.md.
 * If nginx and the reference proxy ever disagree, the docker build has no
 * test coverage — so the rule table lives in exactly one place here and is
 * mirrored by hand in nginx/ofm.conf (they are reviewed together).
 *
 * Run: node scripts/preflight.mjs   (exit 0 = all pass)
 */

import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const ofmDir = path.join(root, 'ofm')

const PUBLIC_ORIGIN = 'http://203.0.113.7:8123' // a public client's view (TEST-NET-3)
const results = []
let failures = 0

function report(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/** Raw HTTP request with full header control (fetch forbids Host). */
function request({ port, method = 'GET', target = '/', headers = {}, body = null, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('request timeout')) })
    if (body !== null) req.write(body)
    req.end()
  })
}

const json = value => JSON.stringify(value)

/** Reference proxy implementing the nginx/ofm.conf rule table. */
function startReferenceProxy(upstreamPort, listenPort) {
  const server = http.createServer((req, res) => {
    const isApi = req.url === '/v1' || req.url.startsWith('/v1/')
    const headers = { ...req.headers }
    delete headers.connection
    delete headers['keep-alive']
    delete headers['transfer-encoding']
    if (!isApi) {
      headers.host = `127.0.0.1:${upstreamPort}`
      delete headers.origin
      delete headers.referer
      delete headers['sec-fetch-site']
    }
    const upstream = http.request({ host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers }, upstreamRes => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    })
    upstream.on('error', error => {
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(json({ error: String(error.message) })) }
      else res.end()
    })
    res.once('close', () => { if (!res.writableEnded) upstream.destroy() })
    req.pipe(upstream)
  })
  return new Promise(resolve => { server.listen(listenPort, '127.0.0.1', () => resolve(server)) })
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-preflight-'))
  const ofmPort = 18990
  const proxyPort = 18989

  // --- start the real service, offline --------------------------------------
  const child = spawn(process.execPath, ['packages/standalone/cli.mjs', '--port', String(ofmPort), '--data-dir', dataDir, '--no-refresh'], {
    cwd: ofmDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OFM_HOME: dataDir },
  })
  let banner = ''
  child.stdout.on('data', chunk => { banner += chunk.toString('utf8') })
  let stderrSoFar = ''
  child.stderr.on('data', chunk => { stderrSoFar += chunk.toString('utf8') })
  const childDied = new Promise(resolve => child.once('exit', code => resolve(code)))

  try {
    // The service prints its banner once the listener is bound. The banner
    // carries the one-time management login token (#login=<token>) and the
    // actual port (it may shift if 18990 is taken — parse, don't assume).
    const deadline = Date.now() + 60000
    while (Date.now() < deadline && !banner.includes('API')) {
      if (childDied.isResolved?.() !== undefined && (await Promise.race([childDied.then(() => true), Promise.resolve(false)]))) {
        throw new Error(`service exited early: ${stderrSoFar}`)
      }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    if (!banner.includes('API')) throw new Error(`service did not start in 60s. stderr: ${stderrSoFar}`)
    const portMatch = /API：http:\/\/127\.0\.0\.1:(\d+)\/v1/.exec(banner) ?? /API.*?http:\/\/127\.0\.0\.1:(\d+)/.exec(banner)
    if (!portMatch) throw new Error(`could not parse service port from banner: ${banner}`)
    const servicePort = Number(portMatch[1])
    const loginToken = /#login=([A-Za-z0-9_-]+)/.exec(banner)?.[1] ?? null

    const proxy = await startReferenceProxy(servicePort, proxyPort)

    try {
      const browserHeaders = {
        host: `${PUBLIC_ORIGIN.replace('http://', '')}`,
        'user-agent': 'preflight-browser/1.0',
        accept: 'text/html,application/xhtml+xml',
        origin: PUBLIC_ORIGIN,
        referer: `${PUBLIC_ORIGIN}/`,
        'sec-fetch-site': 'same-origin',
      }

      // 1. Direct hit with a public Host must be fenced (proves the rewrite
      //    is necessary — the management fence rejects non-loopback Hosts).
      const direct = await request({ port: servicePort, target: '/', headers: { host: '203.0.113.7:8123', origin: PUBLIC_ORIGIN, referer: `${PUBLIC_ORIGIN}/` } })
      report('1 direct public-Host request is rejected 403 by the fence', direct.status === 403, `got ${direct.status}`)

      // 2. Through the proxy, a browser request reaches the management page.
      const page = await request({ port: proxyPort, target: '/', headers: browserHeaders })
      report('2 proxied browser request reaches the management page', page.status === 200 && page.body.toString('utf8').includes('<'), `got ${page.status}`)

      // 3. Proxied management API without credentials: auth (not fence) answers.
      const anonSummary = await request({ port: proxyPort, target: '/api/management/summary', headers: browserHeaders })
      report('3 proxied /api/management/summary without login answers 401 (fence passed)', anonSummary.status === 401, `got ${anonSummary.status}`)

      // 4. The one-time bootstrap link from the banner logs in via the proxy.
      const session = loginToken !== null
        ? await request({
          port: proxyPort, method: 'POST', target: '/api/management/session',
          headers: { ...browserHeaders, 'content-type': 'application/json' },
          body: json({ bootstrapToken: loginToken }),
        })
        : null
      report('4 bootstrap token from the banner exchanges for a session cookie', session !== null && session.status === 200, session === null ? 'no token in banner' : `got ${session.status}`)
      const cookie = /ofm_management_\d+=([A-Za-z0-9_-]+)/.exec(session?.headers['set-cookie']?.join('; ') ?? '')?.[1] ?? null
      const cookieName = /(?:ofm_management_\d+)=/.exec(session?.headers['set-cookie']?.join('; ') ?? '')?.[0]?.replace('=', '') ?? null

      // 5. The session cookie reads the management summary end-to-end.
      const summary = cookie !== null && cookieName !== null
        ? await request({ port: proxyPort, target: '/api/management/summary', headers: { ...browserHeaders, cookie: `${cookieName}=${cookie}` } })
        : null
      report('5 session cookie unlocks the management summary end-to-end', summary !== null && summary.status === 200 && summary.body.toString('utf8').includes('"catalog"'), summary === null ? 'no session' : `got ${summary.status}`)

      // 6. /v1/models without a key: 401 (the API fence is the key itself).
      const noKey = await request({ port: proxyPort, target: '/v1/models', headers: { host: '203.0.113.7:8123' } })
      report('6 /v1/models without a key is 401', noKey.status === 401, `got ${noKey.status}`)

      // 7. The persisted forwardKey authenticates /v1/models through the proxy.
      const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'))
      const key = settings.forwardKey
      const withKey = await request({ port: proxyPort, target: '/v1/models', headers: { host: '203.0.113.7:8123', authorization: `Bearer ${key}` } })
      let modelCount = 0
      try { modelCount = JSON.parse(withKey.body.toString('utf8')).data.length } catch { /* count stays 0 */ }
      report('7 persisted forwardKey authenticates /v1/models via the proxy', withKey.status === 200 && modelCount > 0, `got ${withKey.status}, ${modelCount} models`)

      // 8. /health is open through the proxy (liveness before auth, upstream design).
      const health = await request({ port: proxyPort, target: '/health', headers: browserHeaders })
      report('8 /health answers 200 through the proxy', health.status === 200, `got ${health.status}`)

      // 9. CORS preflight on the API surface passes through untouched.
      const preflight = await request({
        port: proxyPort, method: 'OPTIONS', target: '/v1/chat/completions',
        headers: { host: '203.0.113.7:8123', origin: 'https://elsewhere.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
      })
      report('9 OPTIONS preflight on /v1 passes through (204)', preflight.status === 204, `got ${preflight.status}`)
    } finally {
      await new Promise(resolve => { proxy.closeAllConnections?.(); proxy.close(() => resolve()) })
    }
  } finally {
    child.kill('SIGTERM')
    await Promise.race([childDied, new Promise(resolve => setTimeout(resolve, 5000))])
    fs.rmSync(dataDir, { recursive: true, force: true })
  }

  console.log('')
  console.log(failures === 0 ? `all ${results.length} checks passed` : `${failures}/${results.length} checks FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(error => {
  console.error(`preflight crashed: ${error?.stack ?? error}`)
  process.exit(1)
})
