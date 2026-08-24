// 进度数据持久化：每日计数 / PK 批次 / storyId 去重 / 运行日志
import fs from 'node:fs'
import path from 'node:path'

export class Store {
  constructor(dataDir) {
    this.dir = dataDir
    fs.mkdirSync(this.dir, { recursive: true })
    fs.mkdirSync(path.join(this.dir, 'logs'), { recursive: true })
  }

  dayKey(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  get(file, def = {}) {
    try {
      const p = this.file(file)
      if (!fs.existsSync(p)) return def
      return { ...def, ...JSON.parse(fs.readFileSync(p, 'utf-8')) }
    } catch {
      return def
    }
  }

  set(file, obj) {
    try {
      fs.writeFileSync(this.file(file), JSON.stringify(obj, null, 2), 'utf-8')
    } catch (e) {
      console.error('[store] 写入失败', file, e.message)
    }
  }

  file(name) {
    if (path.isAbsolute(name)) return name
    return path.join(this.dir, name)
  }

  // 每日计数（喂食/洗澡/学习/打工/冒险/PK 等）
  daily(key, field, delta = 0) {
    const f = `daily-${this.dayKey()}.json`
    const d = this.get(f)
    d[key] = d[key] || 0
    d[key] += delta
    if (delta) this.set(f, d)
    return d
  }

  getDaily() {
    return this.get(`daily-${this.dayKey()}.json`)
  }

  // PK 每日批次状态
  pkState() {
    return this.get(`pk-${this.dayKey()}.json`)
  }
  setPkState(state) {
    this.set(`pk-${this.dayKey()}.json`, state)
  }

  // storyId 去重（学习/打工/冒险/被雇佣召回）
  storyKey(storyId) {
    const f = `stories-${this.dayKey()}.json`
    const s = this.get(f)
    s[String(storyId)] = true
    this.set(f, s)
    return true
  }
  hasStory(storyId) {
    return !!(this.get(`stories-${this.dayKey()}.json`)[String(storyId)])
  }

  // 环形日志（最多保留 max 条）
  log(entry, max = 200) {
    const f = 'runtime-log.json'
    const arr = this.get(f, { items: [] }).items || []
    arr.push({ t: Date.now(), ...entry })
    while (arr.length > max) arr.shift()
    this.set(f, { items: arr })
  }
  getLog() {
    return this.get('runtime-log.json', { items: [] }).items || []
  }
}
