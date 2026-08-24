#!/usr/bin/env node
// QQ宠物接口助手 · 萌卡NT插件版 入口
// 支持萌卡NT：正向 WebSocket（插件连框架）与 反向 WebSocket（框架连插件）
// 能力声明以官网发布页勾选快照为准，无需 mengka-plugin.json；WebUI 由框架注入端口与令牌
import fs from 'node:fs'
import path from 'node:path'
import { createAPI } from './sdk.js'
import { createReverseAPI } from './reverse-sdk.js'
import { loadRuntime, PLUGIN_ROOT } from './lib/runtime.js'
import { Store } from './lib/store.js'
import { PetManager } from './lib/pet.js'
import { CommandRouter } from './lib/commands.js'
import { Scheduler } from './lib/scheduler.js'
import { WebUI } from './lib/webui.js'

const rt = loadRuntime()

// ---------- 默认配置合并 ----------
const DEFAULTS = {
  command_prefix: '!',
  command_keywords: ['宠物', 'pet'],
  self_ids: [],
  allowed_groups: [],
  allowed_users: [],
  check_interval: 60,
  auto_manage: false,
  manage: {
    auto_feed: true, auto_bath: true, auto_replenish: true, auto_activity: false,
    feed_item: '饼干', bath_item: '香皂片',
    comfort_threshold: 80, gold_safe_line: 50, activity_priority: 'learn',
  },
  pk: { enabled: false, time: '21:00', batch: 5, friend_id: '' },
  friend_care: { enabled: false, friends: [], interval: 3600, threshold: 80 },
  notify: { group_ids: [], send_result: false },
  web: { host: '127.0.0.1', port: 8090, token: '', basePath: '', authHeader: 'X-Mengka-Admin-Token' },
  data_dir: '',
}
function deepMerge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra)) return extra !== undefined ? extra : base
  if (base && typeof base === 'object' && extra && typeof extra === 'object') {
    const out = { ...base }
    for (const k of Object.keys(extra)) out[k] = deepMerge(base[k], extra[k])
    return out
  }
  return extra !== undefined ? extra : base
}
const cfg = deepMerge(DEFAULTS, rt.cfg || {})

// ---------- 数据目录 ----------
const dataDir = cfg.data_dir || path.join(PLUGIN_ROOT, 'data')
const store = new Store(dataDir)

// ---------- 连接基础 ----------
const token = rt.token || process.env.MENGKA_PLUGIN_TOKEN || ''
const meta = { name: rt.name, version: rt.version, author: rt.author }

let api = null
let mode = (rt.mode === 'auto') ? (rt.url ? 'forward' : 'reverse') : rt.mode

function buildForward() {
  const url = rt.url || `ws://${rt.host || '127.0.0.1'}:${rt.port || 3001}`
  return createAPI({
    url,
    token,
    ...meta,
    autoReconnect: true,
  })
}

function buildReverse() {
  const port = rt.port || 3002
  return createReverseAPI({
    host: rt.host || '0.0.0.0',
    port,
    token,
    ...meta,
  })
}

// ---------- 应用对象 ----------
const app = {
  mode, name: meta.name, version: meta.version, cfg, store, dataDir, token,
  connected: false,
  selfIds: (cfg.self_ids || []),
  bots: new Map(),  // self_id -> { selfId, pet, scheduler, router, connected }
  loadConfigSchema() {
    try { return JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'config.schema.json'), 'utf-8')) } catch { return null }
  },
  saveConfig(next) {
    Object.assign(cfg, deepMerge(DEFAULTS, next))
    cfg.data_dir = dataDir
    fs.writeFileSync(path.join(PLUGIN_ROOT, 'config.json'), JSON.stringify(cfg, null, 2), 'utf-8')
    return cfg
  },
}

// ---------- 消息发送 ----------
async function say(target, text) {
  const selfId = target.selfId
  const message = [{ type: 'text', data: { text } }]
  try {
    if (target.groupId) {
      await api.send_group_msg(selfId, target.groupId, message)
    } else if (target.userId) {
      await api.send_friend_msg(selfId, target.userId, message)
    }
  } catch (e) {
    console.error('[say] 发送失败', e.message)
  }
}

// ---------- 托管命令同步开关（供 commands 回调） ----------
function manageToggle(globalOn) {
  for (const b of app.bots.values()) {
    if (globalOn) b.scheduler.start(); else b.scheduler.stop()
  }
  cfg.auto_manage = globalOn
  try { app.saveConfig(cfg) } catch {}
}

// ---------- 创建 BotNode ----------
function makeBotNode(selfId, onMsg) {
  const pet = new PetManager(api, selfId, store, cfg)
  const router = new CommandRouter({
    pet, cfg, store,
    onManage: (on) => manageToggle(on),
    say,
    getBots: () => Array.from(app.bots.values()),
  })
  const scheduler = new Scheduler({
    pet, cfg, store,
    notify: async (groupId, text) => {
      try { await api.send_group_msg(selfId, groupId, [{ type: 'text', data: { text } }]) } catch {}
    },
    log: (level, text) => { store.log({ level, source: selfId, text }) },
  })
  const node = { selfId, pet, router, scheduler, connected: true }
  app.bots.set(String(selfId), node)
  if (onMsg) onMsg(node)
  if (cfg.auto_manage) scheduler.start()
  return node
}

// ---------- 事件处理 ----------
function handleEvent(msg) {
  const type = msg?.type
  const selfId = String(msg?.self_id || msg?.selfId || '')
  console.error(`[EVT] type=${type} self=${selfId} msg=${(msg?.alt_message ?? msg?.raw_message ?? '').slice(0, 30)}`)
  const node = selfId ? app.bots.get(selfId) || null : null
  console.error(`[EVT] node=${node ? 'yes' : 'no'} bots=${app.bots.size}`)
  if (type === 'group_message') {
    const gid = msg.group_id || msg.groupId
    const uid = msg.user_id || msg.userId
    // 权限过滤
    if (cfg.allowed_groups.length && gid && !cfg.allowed_groups.includes(String(gid))) return
    if (cfg.allowed_users.length && uid && !cfg.allowed_users.includes(String(uid))) return
    const ctx = {
      selfId: selfId || (app.bots.size ? app.bots.keys().next().value : ''),
      groupId: gid, userId: uid,
      altMessage: msg.alt_message ?? msg.raw_message ?? msg.message,
      text: msg.alt_message ?? msg.raw_message ?? msg.message,
    }
    return dispatchToNode(ctx)
  }
  if (type === 'friend_message') {
    const uid = msg.user_id || msg.userId
    if (cfg.allowed_users.length && uid && !cfg.allowed_users.includes(String(uid))) return
    const ctx = {
      selfId: selfId || (app.bots.size ? app.bots.keys().next().value : ''),
      groupId: '', userId: uid,
      altMessage: msg.alt_message ?? msg.raw_message ?? msg.message,
      text: msg.alt_message ?? msg.raw_message ?? msg.message,
    }
    return dispatchToNode(ctx)
  }
}

async function dispatchToNode(ctx) {
  const node = app.bots.get(String(ctx.selfId))
  if (!node) return
  try { await node.router.dispatch(ctx) } catch (e) { console.error('[dispatch]', e.message) }
}

// ---------- WebUI 手动动作 ----------
app.runAction = async function (body) {
  const selfId = String(body.selfId || '')
  const node = selfId ? app.bots.get(selfId) : null
  if (!node) return { ok: false, error: '未知 Bot selfId' }
  const pet = node.pet
  const a = body.action
  try {
    switch (a) {
      case 'status': {
        const s = pet.parseStatus(await pet.snapshot())
        return { ok: true, text: pet.statusText(s), status: s }
      }
      case 'feed': {
        const p = (await pet.snapshot()).profile || {}
        const pid = pet.parseStatus({ profile: p }).petId || body.petId
        const cnt = Math.min(99, Math.max(1, Number(body.count) || 1))
        const r = await pet.feed(pid || 'self', cfg.manage.feed_item, cnt)
        return r
      }
      case 'bath': {
        const r = await pet.bathe(body.petId || 'self', cfg.manage.bath_item, Math.min(99, Math.max(1, Number(body.count) || 1)))
        return r
      }
      case 'buy': {
        return await pet.replenish(body.petId || 'self', 'all')
      }
      case 'settle': {
        return await pet.settleActivity()
      }
      case 'pk_today': {
        return await pet.dailyPkBatch(cfg.pk.batch || 5, cfg.pk.friend_id || '')
      }
      case 'manage': {
        manageToggle(!!body.on)
        return { ok: true, text: `自动托管已${body.on ? '开启' : '关闭'}` }
      }
      default:
        return { ok: false, error: `未知动作 ${a}` }
    }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// ---------- 启动 ----------
async function main() {
  console.log(`\n== QQ宠物助手 · 萌卡NT插件 ==  v${meta.version}`)
  console.log(`运行形态：${mode}  数据目录：${dataDir}`)

  if (mode === 'forward') {
    api = buildForward()
  } else if (mode === 'reverse') {
    api = buildReverse()
  } else {
    console.error('未知运行模式：', mode)
    process.exit(1)
  }

  // 事件注册（兼容 group_notice/friend_notice 旧口径）
  for (const e of ['group_message', 'friend_message']) api.on(e, handleEvent)
  if (rt.args.legacy === '1' || cfg._legacy_notice) {
    api.on('group_notice', handleEvent)
    api.on('friend_notice', handleEvent)
  }

  // 连接生命周期
  api.on?.('_connected', () => {
    app.connected = true
    console.log('已连接萌卡NT 后台')
  })
  api.on?.('_closed', () => { app.connected = false })
  api.on?.('bot_offline', () => { app.connected = false })

  try {
    if (mode === 'forward') {
      await api.connect()
    } else {
      await api.listen()
      console.log(`[reverse] 监听 ${api.wsUrl?.() || ''} 等待萌卡NT 接入`)
    }
  } catch (e) {
    console.error('连接失败：', e.message)
    console.error('请检查：--ws-url/--port、--token 与萌卡NT 插件配置是否正确')
    process.exit(1)
  }

  // 注册已上报的 Bot（若无 self_ids 配置，则等待首个事件时按需创建）
  if (cfg.self_ids && cfg.self_ids.length) {
    for (const sid of cfg.self_ids) makeBotNode(String(sid))
  } else {
    // 兜底：默认创建占位节点，事件到达后按 self_id 惰性创建
  }
  // 惰性创建：无 self_ids 配置时，事件到达自动建节点
  // 已在 handleEvent 入口实现

  // 启动 WebUI（框架托管时使用框架注入的 host/port/basePath/token）
  const webHost = rt.web.host || cfg.web.host || '127.0.0.1'
  const webPort = rt.web.port || process.env.MENGKA_PLUGIN_ADMIN_PORT || cfg.web.port || 8090
  const webToken = rt.web.token || cfg.web.token || ''
  const webui = new WebUI({
    app, token: webToken, host: webHost, port: webPort,
    basePath: rt.web.basePath || cfg.web.basePath || '',
    authHeader: cfg.web.authHeader || 'X-Mengka-Admin-Token',
  })
  try {
    const port = await webui.start()
    console.log(`WebUI 已启动: http://${webHost}:${port}  挂载路径=${webui.basePath || '/'}  ${webToken ? '(带令牌)' : '(无令牌)'}`)
  } catch (e) {
    console.error('WebUI 启动失败：', e.message)
  }

  // 生命周期注册（部分框架版本支持）
  try {
    if (api.controlRegister) {
      await api.controlRegister({
        service: 'qq-pet',
        commands: ['宠物', 'pet'],
        menu: { '宠物': '状态/喂食/洗澡/补货/学习/打工/冒险/结算/pk/好友/托管' },
      }, 3000).catch(() => null)
    }
  } catch {}

  // 优雅退出
  const shutdown = () => { try { webui.stop() } catch {} process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((e) => { console.error(e); process.exit(1) })
