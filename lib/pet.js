// 宠物业务封装：状态 / 喂食 / 洗澡 / 补货 / 学习 / 打工 / 冒险 / PK / 好友
// 所有方法返回 { ok, text, data }，其中 text 为可直接下发 QQ 的文本。
// 字段名对服务器返回做宽容提取，避免字段别名导致解析失败。

function pick(obj, keys, def = '') {
  if (!obj || typeof obj !== 'object') return def
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k]
  }
  return def
}

const NUM = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

export class PetManager {
  constructor(api, selfId, store, cfg) {
    this.api = api
    this.selfId = selfId
    this.store = store
    this.cfg = cfg
    this._foodMap = null   // 名称 -> 目录项
    this._bathMap = null
  }

  // ---------- 状态 ----------
  // 本 SDK 无独立 get_pet_profile：宠物资料由 get_pet_vitals 返回，
  // 叠加 get_level_tasks（等级/阶段）一并聚合。
  async profile() {
    const [v, lt] = await Promise.allSettled([
      this.api.get_pet_vitals(this.selfId),
      this.api.get_level_tasks(this.selfId),
    ])
    const base = v.status === 'fulfilled' ? (v.value || {}) : {}
    if (lt.status === 'fulfilled' && lt.value) {
      base.level_tasks = lt.value
    }
    return base
  }

  async vitals() {
    return await this.api.get_pet_vitals(this.selfId)
  }

  async snapshot() {
    const [prof, act] = await Promise.allSettled([
      this.profile(),
      this.api.get_pet_activity_status(this.selfId),
    ])
    return {
      profile: prof.status === 'fulfilled' ? prof.value : null,
      vitals: prof.status === 'fulfilled' ? prof.value : null,
      activity: act.status === 'fulfilled' ? act.value : null,
    }
  }

  // 将任意返回体解析为标准化状态对象
  parseStatus(snap) {
    const prof = snap.profile || {}
    const vit = snap.vitals || {}
    const act = snap.activity || {}

    const petId = pick(prof, ['pet_id', 'petId', 'id'], '')
    const money = NUM(pick(prof, ['money', 'gold', 'coin', 'coins', 'gold_coin']))
    const mood = NUM(pick(prof, ['mood', 'mood_value', '心情']))
    const energy = NUM(pick(prof, ['energy', 'stamina', '体力']))
    const clean = NUM(pick(prof, ['clean', 'cleanliness', '清洁']))
    const total = NUM(pick(prof, ['total', 'composite', '综合', 'total_value', 'overall']))
    const petName = pick(prof, ['name', 'pet_name', 'nickname', 'pet_name_text'], '')
    const level = pick(prof, ['level', 'grade', 'pet_level', 'qq_level'], '')

    // 活动状态：是否有进行中任务
    const storyId = pick(act, ['story_id', 'storyId'], '')
    const actName = pick(act, ['name', 'activity', 'activity_name', 'option_name'], '')
    const actType = pick(act, ['type', 'activity_type'], '')
    const remainSec = NUM(pick(act, ['remain_sec', 'remain', 'remaining', 'countdown'], 0))

    return {
      petId, money, mood, energy, clean, total, petName, level,
      inActivity: !!storyId, storyId, actName, actType, remainSec,
      raw: { prof, vit, act },
    }
  }

  statusText(s) {
    const act = s.inActivity
      ? `任务[${s.actName || s.actType || '-'}]剩余 ${s.remainSec}s`
      : '空闲'
    return [
      `【${s.petName || '我的宠物'}】`,
      `金币 ${s.money} | 心情 ${s.mood} | 体力 ${s.energy} | 清洁 ${s.clean} | 综合 ${s.total}${s.level ? ' | 等级' + s.level : ''}`,
      act,
    ].join('\n')
  }

  // ---------- 食物 / 洗护目录 ----------
  async ensureFoodMap() {
    if (this._foodMap) return this._foodMap
    try {
      const c = await this.api.get_pet_food_catalog(this.selfId)
      const list = pick(c, ['items', 'foods', 'list', 'catalog'], [])
      this._foodMap = new Map()
      if (Array.isArray(list)) {
        for (const it of list) {
          const id = pick(it, ['food_id', 'foodId', 'id'], '')
          const name = pick(it, ['name', 'food_name', 'title'], '')
          if (name) this._foodMap.set(String(name).toLowerCase(), { id, name, raw: it })
          if (id) this._foodMap.set(String(id).toLowerCase(), { id, name, raw: it })
        }
      }
    } catch (e) { console.warn('[pet] 食物目录获取失败', e.message) }
    return this._foodMap
  }

  async foodCatalog() {
    const c = await this.api.get_pet_food_catalog(this.selfId)
    return { list: pick(c, ['items', 'foods', 'list', 'catalog'], []), raw: c }
  }

  async bathCatalog() {
    const c = await this.api.get_pet_bath_catalog(this.selfId)
    return { list: pick(c, ['items', 'list', 'catalog'], []), raw: c }
  }

  async bathInventory() {
    const it = await this.api.get_pet_bath_inventory(this.selfId)
    return { list: pick(it, ['items', 'inventory', 'list'], []), raw: it }
  }

  async resolveFood(nameOrId) {
    await this.ensureFoodMap()
    return this._foodMap.get(String(nameOrId).toLowerCase())
  }

  // ---------- 喂食 ----------
  async feed(petId, food, count = 1) {
    const data = await this.api.feed_pet(this.selfId, petId, food, count)
    return { ok: true, text: `已喂食 ${food} x${count}`, data }
  }

  // 按缺口计算数量喂食
  async feedByGap(petId, food, gap) {
    const meta = await this.resolveFood(food)
    const name = meta ? meta.name : food
    let count = Math.max(1, Math.ceil(gap / (meta?.raw?.recover || 10)))
    count = Math.min(count, 99)
    return await this.feed(petId, name, count)
  }

  // ---------- 洗澡 ----------
  async bathe(petId, item, count = 1) {
    const data = await this.api.bathe_pet(this.selfId, petId, item, count)
    return { ok: true, text: `已洗澡 ${item} x${count}`, data }
  }

  // ---------- 补货 ----------
  // 按库存缺口一次性购买，返回购买明细
  async replenish(petId, kind = 'all') {
    const [fc, bc, bi] = await Promise.all([
      this.foodCatalog().catch(() => ({ list: [] })),
      this.bathCatalog().catch(() => ({ list: [] })),
      this.bathInventory().catch(() => ({ list: [] })),
    ])
    const bought = []
    const numOf = (arr, id) => NUM(arr.find(x => String(pick(x, ['food_id','foodId','item_id','itemId','id'],'')) === String(id))?.count || NUM(pick(arr.find(x => String(pick(x,['food_id','foodId','item_id','itemId','id'],'')) === String(id)), ['count','num','stock','number'], 0)))

    const need = (name, want = 10) => {
      const meta = this.cfg.items?.find(i => String(i.name).toLowerCase() === String(name).toLowerCase())
      const target = meta?.stock ?? want
      return target
    }

    if (kind === 'food' || kind === 'all') {
      const feedName = this.cfg.manage?.feed_item || '饼干'
      const have = numOf(fc.list, '')
      const cnt = Math.max(0, need(feedName, 10) - have)
      if (cnt > 0) {
        await this.api.buy_pet_food(this.selfId, petId, feedName, cnt)
        bought.push(`饼干 x${cnt}`)
      }
    }
    if (kind === 'bath' || kind === 'all') {
      const bathName = this.cfg.manage?.bath_item || '香皂片'
      const have = numOf(bi.list, '')
      const cnt = Math.max(0, need(bathName, 8) - have)
      if (cnt > 0) {
        await this.api.buy_pet_bath_item(this.selfId, petId, bathName, cnt)
        bought.push(`${bathName} x${cnt}`)
      }
    }
    return {
      ok: true,
      text: bought.length ? `已补货：${bought.join('，')}` : '库存充足，无需补货',
      data: bought,
    }
  }

  // ---------- 学习 / 打工 / 冒险 ----------
  // 目录即 get_pet_activity_options(type) 返回的可选项
  async activityOverview(type) {
    return await this.activityOptions(type)
  }

  async activityOptions(type, friendId = 0) {
    const d = await this.api.get_pet_activity_options(this.selfId, type, friendId)
    return { options: pick(d, ['options', 'items', 'list'], []), raw: d, type }
  }

  // 取当前可执行的最短时长课程/岗位/冒险
  pickShortest(type, options) {
    const arr = Array.isArray(options) ? options : []
    if (!arr.length) return null
    const timeOf = (o) => {
      const t = pick(o, ['duration', 'time', 'length', 'seconds', 'cost_time'], 1e9)
      return NUM(t)
    }
    return arr.sort((a, b) => timeOf(a) - timeOf(b))[0]
  }

  async startActivity(type, optionName, friendId = 0) {
    const d = await this.api.start_pet_activity(this.selfId, type, optionName, friendId)
    const storyId = pick(d, ['story_id', 'storyId'], '')
    if (storyId) this.store.storyKey(storyId)
    return { ok: true, text: `已开始${this.typeName(type)}：${optionName}${storyId ? '（story=' + storyId + '）' : ''}`, data: d, storyId }
  }

  typeName(t) {
    return ({ school: '学习', work: '打工', adventure: '冒险' })[t] || t
  }

  // 结算：先鼓励再结算（写操作回执依赖真实语义，此处 try/catch 聚合）
  async settleActivity() {
    const st = await this.api.get_pet_activity_status(this.selfId)
    const storyId = pick(st, ['story_id', 'storyId'], '')
    let enc = null
    try { enc = await this.api.encourage_pet_activity(this.selfId) } catch (e) { enc = { err: e.message } }
    const rt = await this.api.settle_pet_activity(this.selfId)
    const reward = pick(rt, ['reward', 'gold', 'coin', 'coins', 'result'], '')
    if (storyId) this.store.storyKey(storyId)
    this.store.daily('settle', 'count', 1)
    return { ok: true, text: `结算完成${reward ? '，奖励：' + JSON.stringify(reward) : ''}`, data: { storyId, encourage: enc, result: rt } }
  }

  // ---------- PK ----------
  async pkFriends(cursor = '') {
    const d = await this.api.get_pet_pk_friends(this.selfId, cursor)
    return { friends: pick(d, ['friends', 'items', 'list'], []), cursor: pick(d, ['cursor', 'next_cursor'], ''), raw: d }
  }

  async pkPower() {
    const d = await this.api.get_pet_pk_power(this.selfId)
    return { power: pick(d, ['power', 'score', '战力'], {}), raw: d }
  }

  async startPk(friendId) {
    const d = await this.api.start_pet_pk(this.selfId, friendId)
    const storyId = pick(d, ['story_id', 'storyId'], '')
    return { ok: true, text: `PK 已发起 vs ${friendId}${storyId ? '（story=' + storyId + '）' : ''}`, data: d, storyId }
  }

  async pkStatus(storyId) {
    const d = await this.api.get_pet_pk_status(this.selfId, storyId)
    return { data: d }
  }

  async settlePk(storyId) {
    const d = await this.api.settle_pet_pk(this.selfId, storyId)
    const reward = pick(d, ['reward', 'gold', 'coin', 'coins', 'result'], '')
    this.store.daily('pk', 'count', 1)
    if (storyId) this.store.storyKey(storyId)
    return { ok: true, text: `PK 结算完成${reward ? '：' + JSON.stringify(reward) : ''}`, data: d }
  }

  // 自动 PK 每日批次
  async dailyPkBatch(batch = 5, fixedFriend = '') {
    const state = this.store.pkState()
    const today = this.store.dayKey()
    if (state.done === today) return { ok: true, text: `今日 PK 批次已完成`, data: state }

    const enemies = []
    if (fixedFriend) {
      enemies.push(fixedFriend)
    } else {
      let cursor = ''
      for (let i = 0; i < 3; i++) {
        const page = await this.pkFriends(cursor)
        const list = page.friends || []
        for (const f of list) {
          const fid = pick(f, ['friend_id', 'friendId', 'uin', 'qq'], '')
          if (fid && fid !== this.selfId) enemies.push(fid)
        }
        cursor = page.cursor
        if (!cursor) break
      }
    }
    if (!enemies.length) return { ok: false, text: 'PK 好友池为空，无法自动 PK' }

    const success = []
    let failed = 0
    for (let i = 0; i < batch && i < enemies.length * 3; i++) {
      const fid = enemies[i % enemies.length]
      try {
        const started = await this.startPk(fid)
        if (started.storyId) {
          await this.pauseMs(3000)
          const done = await this.settlePk(started.storyId)
          success.push(fid)
          void done
        } else {
          failed++
        }
      } catch (e) {
        failed++
      }
      await this.pauseMs(1500)
    }

    const next = { ...state, done: today, success, failed, count: success.length, ts: Date.now() }
    this.store.setPkState(next)
    return { ok: true, text: `每日 PK 完成：成功 ${success.length} 场，失败 ${failed} 场`, data: next }
  }

  // ---------- 好友宠物 ----------
  async friendProfile(friendId) {
    const d = await this.api.get_friend_pet_profile(this.selfId, friendId)
    return { data: d }
  }

  async feedFriend(friendId, food) {
    const d = await this.api.feed_friend_pet(this.selfId, friendId, food)
    this.store.daily('friend_feed', 'count', 1)
    return { ok: true, text: `已喂好友宠物 ${food}`, data: d }
  }

  async batheFriend(friendId, item, count = 1) {
    const d = await this.api.bathe_friend_pet(this.selfId, friendId, item, count)
    this.store.daily('friend_bath', 'count', 1)
    return { ok: true, text: `已帮好友宠物洗澡 ${item} x${count}`, data: d }
  }

  async visitFriend(friendId) {
    const d = await this.api.visit_friend_pet(this.selfId, friendId)
    this.store.daily('friend_visit', 'count', 1)
    return { ok: true, text: `已访问好友 ${friendId} 的宠物`, data: d }
  }

  async pokeFriend(friendId) {
    const d = await this.api.poke_friend_pet(this.selfId, friendId)
    return { ok: true, text: `已戳一戳好友 ${friendId} 的宠物`, data: d }
  }

  // 好友照顾：读取好友体力/清洁，低于阈值喂食/洗澡；成功返回描述文本，无操作返回 null
  async friendFeedIfLow(friendId, threshold = 80) {
    try {
      const prof = await this.api.get_friend_pet_profile(this.selfId, friendId)
      const d = prof || {}
      const energy = NUM(pick(d, ['energy', 'stamina', '体力']))
      const clean = NUM(pick(d, ['clean', 'cleanliness', '清洁']))
      const out = []
      let acted = false
      if (energy < threshold) {
        const r = await this.feedFriend(friendId, this.cfg.manage?.feed_item || '饼干')
        out.push(r.text)
        acted = true
      }
      if (clean < threshold) {
        const r = await this.batheFriend(friendId, this.cfg.manage?.bath_item || '香皂片', 1)
        out.push(r.text)
        acted = true
      }
      return acted ? `[${friendId}] ${out.join('，')}` : null
    } catch {
      return null
    }
  }

  pauseMs(ms) { return new Promise(r => setTimeout(r, ms)) }

  // ---------- 工具 ----------
  moneyOf(prof) { return NUM(pick(prof, ['money', 'gold', 'coin', 'coins', 'gold_coin'])) }
  energyOf(vit) { return NUM(pick(vit, ['energy', 'stamina', '体力'])) }
  cleanOf(vit) { return NUM(pick(vit, ['clean', 'cleanliness', '清洁'])) }
}
