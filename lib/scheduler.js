// 自动托管调度器：周期轮询 → 照顾/补货/活动/PK/好友照顾
// 面向单个 Bot 实例；多 Bot 由 index.js 各创建一份。
// 所有写操作先读状态验证缺口，再按阈值执行，并聚合本轮摘要。

export class Scheduler {
  constructor({ pet, cfg, store, notify, log }) {
    this.pet = pet
    this.cfg = cfg
    this.store = store
    this.notify = notify || (async () => {})
    this.log = log || (() => {})
    this.running = false
    this.timer = null
    this.pkTimer = null
    this.friendTimer = null
    this.lastPkSlot = ''
    this.lastFriendCheck = 0
  }

  start() {
    if (this.running) return
    this.running = true
    const iv = Math.max(10, this.cfg.check_interval || 60) * 1000
    this.timer = setInterval(() => { this.tick().catch(e => this.log('error', e.message)) }, iv)
    this.tick().catch(e => this.log('error', e.message))
    this.schedulePk()
    this.scheduleFriend()
    this.log('info', '自动托管已启动')
  }

  stop() {
    this.running = false
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    if (this.pkTimer) { clearInterval(this.pkTimer); this.pkTimer = null }
    if (this.friendTimer) { clearInterval(this.friendTimer); this.friendTimer = null }
    this.log('info', '自动托管已停止')
  }

  // 每日定时 PK：距目标时间最近一次触发
  schedulePk() {
    if (!this.cfg.pk?.enabled) return
    const [h, m] = String(this.cfg.pk.time || '21:00').split(':').map(Number)
    const now = new Date()
    const slot = `${h}:${m}`
    if (this.lastPkSlot !== slot) {
      this.lastPkSlot = slot
      // 每 30s 检查一次当前时刻是否命中
      this.pkTimer = setInterval(() => {
        const d = new Date()
        if (d.getHours() === h && d.getMinutes() === m) {
          this.dailyPk().catch(e => this.log('error', `PK: ${e.message}`))
        }
      }, 30_000)
    }
  }

  scheduleFriend() {
    if (!this.cfg.friend_care?.enabled) return
    const iv = Math.max(60, this.cfg.friend_care.interval || 3600) * 1000
    this.friendTimer = setInterval(() => {
      this.friendCare().catch(e => this.log('error', `好友照顾: ${e.message}`))
    }, iv)
  }

  // ---------- 主轮询 ----------
  async tick() {
    if (!this.running) return
    const lines = []
    let snap
    try {
      snap = await this.pet.snapshot()
    } catch (e) {
      this.log('error', `状态读取失败: ${e.message}`)
      return
    }
    const s = this.pet.parseStatus(snap)
    const m = this.cfg.manage || {}

    // 1) 照顾：体力/清洁低于阈值
    if (m.auto_feed && s.energy < m.comfort_threshold) {
      try {
        const r = await this.pet.feedByGap(s.petId, m.feed_item || '饼干', m.comfort_threshold - s.energy)
        lines.push(r.text)
        this.store.daily('feed', 'count', 1)
      } catch (e) { lines.push(`喂食失败: ${e.message}`) }
    }
    if (m.auto_bath && s.clean < m.comfort_threshold) {
      try {
        const r = await this.pet.bathe(s.petId, m.bath_item || '香皂片', 1)
        lines.push(r.text)
        this.store.daily('bath', 'count', 1)
      } catch (e) { lines.push(`洗澡失败: ${e.message}`) }
    }

    // 2) 空闲自动活动
    if (m.auto_activity && !s.inActivity) {
      try {
        const type = m.activity_priority || 'learn'
        const ov = await this.pet.activityOptions(type)
        const opts = ov.options || []
        if (opts.length) {
          const best = this.pet.pickShortest(type, opts)
          if (best) {
            const name = pickName(best)
            const r = await this.pet.startActivity(type, name)
            lines.push(r.text)
            this.store.daily('activity_' + type, 'count', 1)
          }
        }
      } catch (e) { lines.push(`自动活动失败: ${e.message}`) }
    }

    // 3) 有进行中任务且超时 → 结算
    if (s.inActivity && s.remainSec <= 0) {
      try {
        const r = await this.pet.settleActivity()
        lines.push(r.text)
      } catch (e) { lines.push(`结算失败: ${e.message}`) }
    }

    if (lines.length) {
      this.log('info', lines.join('；'))
      const notifyGroups = this.cfg.notify?.group_ids || []
      if (notifyGroups.length && this.cfg.notify?.send_result) {
        for (const g of notifyGroups) await this.notify(g, lines.join('\n'))
      }
    }
  }

  // ---------- 每日 PK ----------
  async dailyPk() {
    const state = this.store.pkState()
    if (state.done === this.store.dayKey()) return
    const r = await this.pet.dailyPkBatch(this.cfg.pk.batch || 5, this.cfg.pk.friend_id || '')
    this.log('info', r.text)
    const groups = this.cfg.notify?.group_ids || []
    for (const g of groups) await this.notify(g, r.text)
  }

  // ---------- 好友照顾 ----------
  async friendCare() {
    // 避免与主循环过密
    if (Date.now() - this.lastFriendCheck < 60_000) return
    this.lastFriendCheck = Date.now()
    const fc = this.cfg.friend_care || {}
    const list = await this.pet.pkFriends('')
    const friends = list.friends || []
    const targets = fc.friends && fc.friends.length ? fc.friends : friends.map(f => pick(f, ['friend_id', 'friendId', 'uin'], '')).filter(Boolean)
    const threshold = fc.threshold || 80
    const lines = []
    for (const fid of targets) {
      try {
        const r = await this.pet.friendFeedIfLow(fid, threshold)
        if (r) lines.push(r)
      } catch { /* 单个好友失败跳过 */ }
      await this.pet.pauseMs(1500)
    }
    if (lines.length) {
      this.log('info', `好友照顾: ${lines.join('；')}`)
      const groups = this.cfg.notify?.group_ids || []
      if (groups.length) for (const g of groups) await this.notify(g, lines.join('\n'))
    }
  }
}

function pick(o, keys, def = '') {
  if (!o || typeof o !== 'object') return def
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null) return o[k]
  }
  return def
}
function pickName(o) {
  return pick(o, ['name', 'title', 'option_name', 'optionName', 'course', 'job', '职业'])
}
