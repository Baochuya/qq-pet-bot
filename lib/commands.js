// 命令分发：消息文本 -> 子命令树 -> 宠物业务 -> 回执
// 命令示例（前缀 默认 !）：
//   !宠物 状态 / !宠物 喂食 [xN] / !宠物 洗澡 / !宠物 补货
//   !宠物 学习|打工|冒险 [列表|开始 <名称>] / !宠物 结算
//   !宠物 pk 开始 [QQ] / !宠物 pk 结算 [storyId] / !宠物 pk 今日
//   !宠物 好友 列表 / !宠物 好友 照顾 [QQ] / !宠物 托管 on|off
//   !宠物 帮助

const SUB = {
  status: ['状态', 'status', 'info', '查询'],
  feed: ['喂食', 'feed', '吃'],
  bath: ['洗澡', 'bath', '洗'],
  buy: ['补货', 'buy', 'replenish', '购买'],
  learn: ['学习', 'learn', 'school'],
  work: ['打工', 'work', 'job'],
  adventure: ['冒险', 'adventure'],
  settle: ['结算', 'settle', '收菜'],
  pk: ['pk', '对决'],
  friend: ['好友', 'friend'],
  manage: ['托管', 'manage', 'auto'],
  help: ['帮助', 'help', 'menu', '菜单'],
}

// 把 alt_message 解析为纯文本（兼容数组段）
export function extractText(alt) {
  if (typeof alt === 'string') return alt
  if (Array.isArray(alt)) {
    return alt.filter(seg => seg && seg.type === 'text').map(seg => seg.data?.text ?? (seg.text || '')).join(' ')
  }
  return ''
}

// 一级功能词（可选前缀）：!宠物 状态 与 !状态 均可用
const ROOT_ALIAS = ['宠物', 'pet', 'qpet', 'qq宠物']

export function parseCommand(msg, prefix, keywords) {
  msg = (msg || '').trim()
  if (!prefix) prefix = '!'
  keywords = Array.isArray(keywords) ? keywords : []
  let rest = ''
  // 方式一：带前缀，如 "!宠物 状态"
  if (msg.startsWith(prefix) && msg.length > prefix.length) {
    rest = msg.slice(prefix.length).trim()
  }
  // 方式二：免前缀关键词，如 "宠物 状态"
  if (!rest) {
    for (const kw of keywords) {
      if (kw && msg.startsWith(kw)) { rest = msg.slice(kw.length).trim(); break }
    }
  }
  if (!rest) return null
  const parts = rest.split(/\s+/).filter(Boolean)
  if (ROOT_ALIAS.includes(parts[0].toLowerCase())) parts.shift()
  const head = parts.shift()?.toLowerCase() || ''
  if (!head) return null
  return { root: head, parts }
}

export class CommandRouter {
  constructor({ pet, cfg, store, onManage, say, getBots }) {
    this.pet = pet
    this.cfg = cfg
    this.store = store
    this.onManage = onManage   // (on:boolean) => void
    this.say = say             // async (target, text) => void
    this.getBots = getBots     // () => [{selfId, pet}]
    this._petIdCache = new Map()
  }

  async ensurePetId() {
    const c = this._petIdCache.get(this.pet.selfId)
    if (c) return c
    try {
      const snap = await this.pet.snapshot()
      const s = this.pet.parseStatus(snap)
      this._petIdCache.set(this.pet.selfId, s.petId)
      return s.petId
    } catch { return '' }
  }

  cloud(petId) { this._petIdCache.set(this.pet.selfId, petId) }

  // 返回 true 表示已消费该消息
  async dispatch(ctx) {
    const evt = extractText(ctx.altMessage || ctx.text)
    const cmd = parseCommand(evt, this.cfg.command_prefix || '!', this.cfg.command_keywords || [])
    if (!cmd) return false

    // 主体关键词不是子命令时增加一层指令名匹配（兼容 “宠物 状态”与“状态”两种写法）
    const tree = this.buildTree(cmd.root)
    if (!tree) return false
    return await tree.handler(ctx, cmd.parts || [])
  }

  buildTree(root) {
    // “状态/喂食/...” 直接作为一级命令
    for (const [name, kw] of Object.entries(SUB)) {
      if (kw.includes(root)) {
        const fn = this['cmd_' + name]
        if (fn && typeof fn === 'function') return { name, handler: fn.bind(this) }
      }
    }
    return null
  }

  async reply(ctx, text) {
    await this.say({ selfId: ctx.selfId, groupId: ctx.groupId, userId: ctx.userId }, text)
  }

  ok(ctx, text) { return this.reply(ctx, text).then(() => true) }

  // ---------- 子命令实现 ----------
  async cmd_status(ctx) {
    const snap = await this.pet.snapshot()
    const s = this.pet.parseStatus(snap)
    this.cloud(s.petId)
    const extra = []
    if (s.inActivity) extra.push(`story=${s.storyId}`)
    return this.ok(ctx, this.pet.statusText(s) + (extra.length ? '\n' + extra.join(' ') : ''))
  }

  async cmd_feed(ctx, parts) {
    const petId = await this.ensurePetId()
    if (!petId) return this.ok(ctx, '未获取到宠物 petId，先使用「!宠物 状态」初始化')
    const item = this.cfg.manage?.feed_item || '饼干'
    let count = 1
    const arg = (parts[0] || '').toLowerCase()
    if (arg.startsWith('x')) count = parseInt(arg.slice(1), 10) || 1
    count = Math.min(Math.max(count, 1), 99)
    const r = await this.pet.feed(petId, item, count)
    return this.ok(ctx, r.text)
  }

  async cmd_bath(ctx) {
    const petId = await this.ensurePetId()
    if (!petId) return this.ok(ctx, '未获取到宠物 petId，先使用「!宠物 状态」初始化')
    const item = this.cfg.manage?.bath_item || '香皂片'
    const r = await this.pet.bathe(petId, item, 1)
    return this.ok(ctx, r.text)
  }

  async cmd_buy(ctx) {
    const petId = await this.ensurePetId()
    if (!petId) return this.ok(ctx, '未获取到宠物 petId')
    const r = await this.pet.replenish(petId, 'all')
    return this.ok(ctx, r.text)
  }

  async actFlow(ctx, type, parts) {
    const petId = await this.ensurePetId()
    if (!petId) return this.ok(ctx, '未获取到宠物 petId')
    const ver = this.pet.typeName(type)
    // 列表
    if (!parts.length || parts[0] === '列表' || parts[0] === 'list') {
      let opts = []
      try {
        const ov = await this.pet.activityOverview(type)
        opts = ov.options || []
      } catch {
        const o2 = await this.pet.activityOptions(type)
        opts = o2.options || []
      }
      if (!opts.length) return this.ok(ctx, `${ver}目录为空或接口不可用`)
      const short = this.pet.pickShortest(type, opts)
      const nameOf = (o) => pickName(o)
      const lines = opts.slice(0, 15).map(o => `- ${nameOf(o)}${short === o ? ' ←最短' : ''}`)
      return this.ok(ctx, `${ver}可选目录（${opts.length}项）：\n` + lines.join('\n'))
    }
    if (parts[0] === '开始' || parts[0] === 'start') {
      const name = parts.slice(1).join(' ')
      if (!name) return this.ok(ctx, `请指定${ver}项目名：!宠物 ${type} 开始 <名称>`)
      const r = await this.pet.startActivity(type, name)
      return this.ok(ctx, r.text)
    }
    // 直接给名称 = 开始
    const name = parts.join(' ')
    const r = await this.pet.startActivity(type, name)
    return this.ok(ctx, r.text)
  }

  cmd_learn(ctx, p) { return this.actFlow(ctx, 'school', p) }
  cmd_work(ctx, p) { return this.actFlow(ctx, 'work', p) }
  cmd_adventure(ctx, p) { return this.actFlow(ctx, 'adventure', p) }

  async cmd_settle(ctx) {
    const r = await this.pet.settleActivity()
    return this.ok(ctx, r.text)
  }

  async cmd_pk(ctx, parts) {
    const sub = (parts[0] || '').toLowerCase()
    if (sub === '开始' || sub === 'start') {
      const fid = parts[1] || ''
      if (!fid) return this.ok(ctx, '请提供对手 QQ：!宠物 pk 开始 <QQ>')
      const r = await this.pet.startPk(fid)
      return this.ok(ctx, r.text)
    }
    if (sub === '结算' || sub === 'settle') {
      const sid = parts[1] || ''
      if (!sid) return this.ok(ctx, '请提供 storyId：!宠物 pk 结算 <storyId>')
      const r = await this.pet.settlePk(sid)
      return this.ok(ctx, r.text)
    }
    if (sub === '今日' || sub === 'batch') {
      const batch = this.cfg.pk?.batch || 5
      const fixed = this.cfg.pk?.friend_id || ''
      const r = await this.pet.dailyPkBatch(batch, fixed)
      return this.ok(ctx, r.text)
    }
    // 列表 & 战力
    if (sub === '列表' || sub === 'list') {
      const r = await this.pet.pkFriends('')
      const list = r.friends || []
      const lines = list.slice(0, 20).map(f => `- ${pick(f, ['nickname','name','备注','friend_uin','uin','friend_id','friendId'],'?')} (${pick(f, ['friend_id','friendId','uin'],'?')})`)
      return this.ok(ctx, `PK 好友池（${list.length}）：\n` + (lines.join('\n') || '（空）'))
    }
    const pw = await this.pet.pkPower()
    return this.ok(ctx, `我的战力：${JSON.stringify(pw.power || '?')}\n用法：!宠物 pk 开始 <QQ> / 结算 <storyId> / 今日`)
  }

  async cmd_friend(ctx, parts) {
    const sub = (parts[0] || '').toLowerCase()
    const fidArg = parts[1] || ''
    if (sub === '列表' || sub === 'list') {
      const r = await this.pet.pkFriends('')  // 好友池复用
      const list = r.friends || []
      const lines = list.slice(0, 20).map(f => `- ${pick(f, ['nickname','name','备注'],'?')} (${pick(f, ['friend_id','friendId','uin'],'?')})`)
      return this.ok(ctx, `好友宠物池（${list.length}）：\n` + (lines.join('\n') || '（空）'))
    }
    if ((sub === '照顾' || sub === 'visit' || sub === 'feed' || sub === 'bathe') && fidArg) {
      if (sub === 'feed') { const r = await this.pet.feedFriend(fidArg, this.cfg.manage?.feed_item || '饼干'); return this.ok(ctx, r.text) }
      if (sub === 'bathe') { const r = await this.pet.batheFriend(fidArg, this.cfg.manage?.bath_item || '香皂片'); return this.ok(ctx, r.text) }
      const r = await this.pet.visitFriend(fidArg)
      return this.ok(ctx, r.text)
    }
    if (sub === '照顾' || sub === 'visit') {
      return this.ok(ctx, '用法：!宠物 好友 照顾 <QQ>（也可 feed/bathe）')
    }
    return this.ok(ctx, '用法：!宠物 好友 列表 | 照顾 <QQ> | feed <QQ> | bathe <QQ>')
  }

  async cmd_manage(ctx, parts) {
    const sub = (parts[0] || '').toLowerCase()
    if (sub === 'on' || sub === '开' || sub === 'start') {
      this.onManage(true)
      return this.ok(ctx, '自动托管已开启')
    }
    if (sub === 'off' || sub === '关' || sub === 'stop') {
      this.onManage(false)
      return this.ok(ctx, '自动托管已关闭')
    }
    return this.ok(ctx, '用法：!宠物 托管 on|off')
  }

  async cmd_help(ctx) {
    const p = this.cfg.command_prefix || '!'
    return this.ok(ctx, [
      `QQ宠物助手 · ${p}宠物`,
      `状态 | 喂食[xN] | 洗澡 | 补货`,
      `学习/打工/冒险 [列表|开始 <名称>]`,
      `结算 | pk(开始/结算/今日) | 好友(列表/照顾/feed/bathe)`,
      `托管(开/关) | 帮助`,
      ``,
      `可在 WebUI 配置自动托管与每日 PK：`,
    ].join('\n'))
  }
}

function pickName(o) {
  return pick(o, ['name', 'title', 'option_name', 'optionName', 'course', 'job', '职业'])
}
function pick(o, keys, def = '') {
  if (!o || typeof o !== 'object') return def
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null) return o[k]
  }
  return def
}
