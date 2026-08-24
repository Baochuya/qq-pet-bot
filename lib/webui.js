// WebUI：轻量 HTTP 服务，提供静态页 + JSON API
// 优先监听框架托管的 127.0.0.1:{port} 与注入令牌；独立运行时可手动指定。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = path.resolve(__dirname, '..', 'web')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

export class WebUI {
  constructor({ app, token = '', host = '127.0.0.1', port = 8090, authHeader = '', basePath = '' }) {
    this.app = app
    this.token = token
    this.host = host
    this.port = port
    this.authHeader = authHeader || 'X-Mengka-Admin-Token'
    this.basePath = (basePath || app.cfg?.web?.basePath || '').replace(/\/+$/, '')
    this.server = null
    this.actualPort = port
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handle(req, res))
      this.server.on('error', reject)
      this.server.listen(this.port, this.host, () => {
        this.actualPort = this.server.address().port
        resolve(this.actualPort)
      })
    })
  }

  stop() {
    if (this.server) { try { this.server.close() } catch {} this.server = null }
  }

  async handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const base = this.basePath
    // 框架托管可能带基础路径
    let pathname = url.pathname
    if (base && pathname.startsWith(base)) pathname = pathname.slice(base.length) || '/'

    // 令牌校验（无令牌时不校验）：支持 Authorization Bearer、X-Mengka-Admin-Token 头与 query token
    if (this.token) {
      const auth = req.headers['authorization'] || ''
      const h = req.headers[this.authHeader.toLowerCase()] || ''
      const q = url.searchParams.get('token') || ''
      const ok = auth === `Bearer ${this.token}` || h === this.token || q === this.token
      if (!ok) return this.json(res, 401, { error: 'unauthorized' })
    }

    if (pathname === '/' || pathname === '/index.html') return this.serveFile(res, 'index.html')
    if (pathname.startsWith('/api/')) return this.api(req, res, pathname, url)

    // 静态资源
    const rel = pathname.replace(/^\/+/, '')
    if (rel && rel !== 'favicon.ico') return this.serveFile(res, rel)
    return this.serveFile(res, 'index.html')
  }

  serveFile(res, rel) {
    let fp
    try {
      fp = path.normalize(path.join(WEB_ROOT, rel))
      if (!fp.startsWith(WEB_ROOT)) return this.json(res, 403, { error: 'forbidden' })
    } catch {
      return this.json(res, 400, { error: 'bad path' })
    }
    if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) return this.json(res, 404, { error: 'not found' })
    const ext = path.extname(fp).toLowerCase()
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
    fs.createReadStream(fp).pipe(res)
  }

  json(res, code, obj) {
    const body = JSON.stringify(obj)
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
    res.end(body)
  }

  async body(req) {
    return new Promise((resolve) => {
      let d = ''
      req.on('data', c => { d += c; if (d.length > 1e6) req.destroy() })
      req.on('end', () => { try { resolve(JSON.parse(d || '{}')) } catch { resolve({}) } })
      req.on('error', () => resolve({}))
    })
  }

  async api(req, res, pathname, url) {
    const app = this.app
    const m = pathname.match(/^\/api\/([a-z_]+)\/?$/)
    if (!m) return this.json(res, 404, { error: 'no such api' })
    const name = m[1]
    try {
      if (req.method === 'GET' && name === 'status') {
        const bots = []
        for (const b of app.bots.values()) {
          let status = null
          try {
            const s = b.pet.parseStatus(await b.pet.snapshot())
            status = { petId: s.petId, petName: s.petName, money: s.money, mood: s.mood, energy: s.energy, clean: s.clean, total: s.total, inActivity: s.inActivity, storyId: s.storyId, remainSec: s.remainSec }
          } catch (e) { status = { error: e.message } }
          bots.push({ selfId: b.selfId, connected: b.connected, managing: b.scheduler.running, status })
        }
        return this.json(res, 200, {
          mode: app.mode,
          name: app.name,
          version: app.version,
          connected: app.connected,
          selfIds: app.selfIds,
          bots,
          web: { host: this.host, port: this.actualPort, tokenSet: !!this.token },
          ts: Date.now(),
        })
      }
      if (req.method === 'GET' && name === 'config') {
        return this.json(res, 200, { config: app.cfg, configSchema: app.loadConfigSchema() })
      }
      if (req.method === 'POST' && name === 'config') {
        const body = await this.body(req)
        const saved = app.saveConfig(body.config || {})
        return this.json(res, 200, { ok: true, config: saved })
      }
      if (req.method === 'POST' && name === 'manage') {
        const body = await this.body(req)
        const on = !!body.on
        for (const b of app.bots.values()) {
          if (on) await b.scheduler.start(); else await b.scheduler.stop()
        }
        app.cfg.auto_manage = on
        app.saveConfig(app.cfg)
        return this.json(res, 200, { ok: true, on })
      }
      if (req.method === 'POST' && name === 'action') {
        const body = await this.body(req)
        const r = await app.runAction(body)
        return this.json(res, r.ok ? 200 : 400, r)
      }
      if (req.method === 'GET' && name === 'log') {
        return this.json(res, 200, { items: app.store.getLog() })
      }
      if (req.method === 'GET' && name === 'daily') {
        return this.json(res, 200, { day: app.store.dayKey(), daily: app.store.getDaily() })
      }
      return this.json(res, 404, { error: 'no such api' })
    } catch (e) {
      return this.json(res, 500, { error: e.message })
    }
  }
}
