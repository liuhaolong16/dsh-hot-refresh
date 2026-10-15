// dsh-hot-refresh —— 宿主侧真实现 v0.3.0（由 ../index.js 按版本号动态导入）
//
// 逆向来源（本机 app.asar 内 @deepseek-ai/dsh-client-hmr v0.2.0-rc.2，MIT，作者 Shigma）：
//   · 宿主半体每 pollIntervalMs(默认 500ms) stat 轮询每个客户端 bundle 的 {mtimeMs,ctimeMs,size}；
//     一变就 `ctx.clientModules.rebuilt(id)` ⇒ SSE `/plugins/events` 推 rebuilt 帧；
//   · 浏览器半体收到帧 ⇒ `ctx.modules.entries.reload(id, rev)` 就地替换（见 dsh-client-modules）。
//
// v0.3.0 相对 v0.2.0：内容等价，只是**搬进 lib/host/impl.js 以支持"停用+启用"热升级**；
// 并在 /health 里加 `entry` 字段说明自己是被哪个入口加载的（便于核对"到底换上了没"）。
export const name = 'hot-refresh'
export const inject = ['webServer']

const VERSION = '0.4.0'
const REPORTS = []
const MAX_REPORTS = 20

let APPLIES = 0
let APPLIED_AT = null

function send(res, code, body) {
  try {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  } catch (e) { try { res.end() } catch (_) {} }
}

function readGraph(ctx) {
  try {
    const cm = ctx.get('clientModules')
    if (!cm || typeof cm.graph !== 'function') return null
    const g = cm.graph()
    const entries = (g && g.entries) || []
    return entries.map((r) => ({ id: String((r && r.id) || ''), rev: String((r && r.rev) || '') }))
  } catch (e) { return null }
}

function reload(ctx, id, opts) {
  const allowAll = !!(opts && opts.allowAll)
  // ★ v0.4.0：支持**精确重载一小组行**（?ids=a,b,c）——客户端据 rev 差分挑出"自上次后变了的那几个"，
  //   于是常见情况下不必整图重载（也就不会丢整图 React 状态）。空数组视为未指定。
  const ids = Array.isArray(opts && opts.ids)
    ? opts.ids.map((x) => String(x == null ? '' : x).trim()).filter(Boolean)
    : []
  const done = []
  const failed = []
  let cm = null
  try { cm = ctx.get('clientModules') } catch (e) { cm = null }
  if (!cm || typeof cm.rebuilt !== 'function') return { ok: false, reason: 'no-client-modules', done, failed }
  const entries = readGraph(ctx) || []
  if (!id && !ids.length && !allowAll) {
    return {
      ok: false, reason: 'need-explicit-all', rows: entries.length, done, failed,
      hint: '整图重载会丢失所有插件的 React 状态；确认请加 ?all=1，或改用 ?id=<rowId> / ?ids=a,b,c 精确重载',
    }
  }
  let targets
  if (id) targets = entries.filter((r) => r.id === id)
  else if (ids.length) targets = entries.filter((r) => ids.indexOf(r.id) >= 0)
  else targets = entries
  const unknown = id
    ? (targets.length ? [] : [id])
    : ids.filter((x) => !entries.some((r) => r.id === x))
  if (unknown.length) {
    return { ok: false, reason: 'unknown-id', id: id || '', ids: unknown, done, failed, known: entries.map((r) => r.id) }
  }
  for (const row of targets) {
    try { cm.rebuilt(row.id); done.push(row.id) }
    catch (e) { failed.push({ id: row.id, error: String((e && e.message) || e) }) }
  }
  return { ok: failed.length === 0, all: !id && !ids.length, done, failed }
}

export function apply(ctx) {
  // 非 Web 组合（headless）没有 webServer ⇒ 安静退出，绝不抛
  const webServer = ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : (ctx && ctx.webServer)
  if (!webServer || typeof webServer.register !== 'function') {
    try { console.warn('[hot-refresh] 本宿主没有 webServer（非 Web 组合）⇒ 插件不注册路由，宿主不受影响') } catch (e) {}
    return
  }
  APPLIES += 1
  APPLIED_AT = new Date().toISOString()

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/hot-refresh',
    handler: async (req, res) => {
      try {
        const url = new URL(String(req.url || '/'), 'http://127.0.0.1')
        const rel = url.pathname.replace(/^\/hot-refresh\/?/, '')
        const q = url.searchParams

        if (rel === '' || rel === 'health') {
          const entries = readGraph(ctx)
          let cmOk = false
          try { const cm = ctx.get('clientModules'); cmOk = !!(cm && typeof cm.rebuilt === 'function') } catch (e) { cmOk = false }
          return send(res, 200, JSON.stringify({
            ok: true, version: VERSION, entry: 'lib/host/impl.js',
            applies: APPLIES, appliedAt: APPLIED_AT,
            clientModules: cmOk,
            rows: entries ? entries.length : null,
            ids: entries ? entries.map((r) => r.id) : null,
            graph: entries ? entries.map((r) => ({ id: r.id, rev: r.rev })) : null,   // ★ v0.4.0：客户端据此差分"哪些变了"
            reports: REPORTS.slice(-10),
          }))
        }

        if (rel === 'reload') {
          const id = String(q.get('id') || '').trim() || null
          const all = q.get('all') === '1' || q.get('all') === 'true'
          const ids = String(q.get('ids') || '').split(',').map((x) => x.trim()).filter(Boolean)
          const r = reload(ctx, id, { allowAll: all, ids })
          const code = r.ok ? 200 : (r.reason === 'need-explicit-all' ? 400 : 503)
          return send(res, code, JSON.stringify({ ok: r.ok, version: VERSION, ...r }))
        }

        if (rel === 'report') {
          const raw = await readBody(req)
          let body = null
          try { body = JSON.parse(raw || '{}') } catch (e) { body = { parseError: String((e && e.message) || e) } }
          REPORTS.push({ at: new Date().toISOString(), hostVersion: VERSION, ...(body && typeof body === 'object' ? body : { raw: String(body) }) })
          while (REPORTS.length > MAX_REPORTS) REPORTS.shift()
          return send(res, 200, JSON.stringify({ ok: true, version: VERSION, n: REPORTS.length }))
        }

        return send(res, 404, JSON.stringify({ ok: false, error: 'not found' }))
      } catch (e) {
        return send(res, 500, JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
      }
    },
  }), 'hot-refresh: routes')
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    try {
      req.on('data', (c) => { data += c; if (data.length > 200000) data = data.slice(0, 200000) })
      req.on('end', () => resolve(data))
      req.on('error', () => resolve(data))
    } catch (e) { resolve('') }
  })
}
