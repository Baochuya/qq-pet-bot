// 运行参数与配置解析
// ----------
// 支持两种运行形态：
//   A) 萌卡NT 市场托管/手动安装：框架通过 CLI 参数与 (admin|connection).json 注入连接信息
//   B) 开发者直接运行：--mode forward/reverse + --ws-url/--port + --token 直连联调
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ROOT = path.resolve(__dirname, '..')

export function readJsonSilent(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) } catch { return null }
}

// 从 CLI 参数解析 key/value（支持 --key=value 与 --key value 两种写法）
function parseArgs(argv) {
  const map = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq !== -1) {
      map[a.slice(2, eq)] = a.slice(eq + 1)
    } else {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        map[key] = next
        i++
      } else {
        map[key] = true
      }
    }
  }
  return map
}

export function loadRuntime() {
  const args = parseArgs(process.argv.slice(2))

  // ---- 模式 ----
  const mode = (args.mode || process.env.MENGKA_PLUGIN_MODE || 'auto').toLowerCase()

  // ---- 插件元信息（桥接 SDK 认证） ----
  let pkg = readJsonSilent(path.join(PLUGIN_ROOT, 'package.json')) || {}
  const name = args.name || process.env.MENGKA_PLUGIN_NAME || pkg.name || 'qq-pet-mengka-plugin'
  const version = args.version || process.env.MENGKA_PLUGIN_VERSION || pkg.version || '1.0.0'
  const author = args.author || process.env.MENGKA_PLUGIN_AUTHOR || pkg.author || 'qq-pet'

  // ---- 连接信息 ----
  const url = args['ws-url'] || args.url || process.env.MENGKA_PLUGIN_WS_URL || ''
  const tokenArg = args.token || process.env.MENGKA_PLUGIN_TOKEN || ''
  const connectionFile = args.connection || process.env.MENGKA_PLUGIN_CONNECTION_FILE || ''
  const tokenFile = args['token-file'] || process.env.MENGKA_PLUGIN_TOKEN_FILE || process.env.MENGKA_PLUGIN_ADMIN_TOKEN_FILE || ''

  // 连接信息文件（不含明文令牌）宽容解析：可能为 {host,port,path} / {url,ws_url} 等
  let conn = {}
  if (connectionFile && fs.existsSync(connectionFile)) {
    const raw = readJsonSilent(connectionFile)
    if (raw) conn = raw
  }
  const finalUrl = url || conn.url || conn.ws_url || conn.connection?.url || ''
  const finalHost = conn.host || conn.admin_host || ''
  const finalPort = conn.port ?? conn.admin_port ?? 0
  let finalToken = tokenArg || conn.token || ''
  // 令牌文件（框架托管提供的明文令牌）
  if (!finalToken && tokenFile && fs.existsSync(tokenFile)) {
    finalToken = String(fs.readFileSync(tokenFile, 'utf-8')).trim()
  }

  // ---- WebUI 托管环境注入（框架托管占位符：{{admin_host}}/{{admin_port}}/{{admin_base_path}}/{{admin_token_file}}） ----
  const web = {
    host: args['admin-host'] || process.env.MENGKA_PLUGIN_ADMIN_HOST || conn.web_host || '127.0.0.1',
    port: Number(args['admin-port'] || process.env.MENGKA_PLUGIN_ADMIN_PORT || conn.web_port || 0),
    basePath: args['admin-base-path'] || process.env.MENGKA_PLUGIN_ADMIN_BASE_PATH || conn.base_path || '',
    tokenFile: args['admin-token-file'] || process.env.MENGKA_PLUGIN_ADMIN_TOKEN_FILE || conn.admin_token_file || '',
    token: '',
  }
  if (web.tokenFile && fs.existsSync(web.tokenFile)) {
    web.token = String(fs.readFileSync(web.tokenFile, 'utf-8')).trim()
  }

  // ---- 配置文件 ----
  let cfg = {}
  if (args.config || process.env.MENGKA_PLUGIN_CONFIG_FILE) {
    const cf = args.config || process.env.MENGKA_PLUGIN_CONFIG_FILE
    cfg = readJsonSilent(cf) || {}
  } else {
    cfg = readJsonSilent(path.join(PLUGIN_ROOT, 'config.json')) || {}
  }
  if (args['data-dir']) cfg.data_dir = args['data-dir']

  return { args, mode, name, version, author, url: finalUrl, host: finalHost, port: finalPort, token: finalToken, connectionFile, web, cfg }
}
