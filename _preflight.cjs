// _preflight.cjs —— dsh-hot-refresh 的"升级/重启前必过门"（只读，不改任何东西）
//
// 为什么需要它（用户要求"记得保证兼容性"）：这个插件动的是**整张客户端插件图**，
// 一旦护栏失效就会把用户整个界面重载一遍（React 状态全丢）；而 HMR 会**重放**插件的 apply，
// 注册若不幂等就会累积。这些都不是"看起来能跑"能证明的，必须逐条断言。
//
// 判据（任一 FAIL 则退出码 1）：
//   A 包元数据：package.json 严格 JSON + 身份可读
//   B 版本一致：package.json ↔ 客户端 VERSION ↔ 宿主 VERSION（跨版本混装是"看着没反应"的常见根因）
//   C 语法：两个半体 node --check
//   D 客户端形状夹具（_check-client.cjs）
//   E 宿主半体：桩 ctx 直调 apply ⇒ 注册形状正确；**再调一次不抛且可观测（applies 计数）**
//   F 敌意 ctx：undefined / null / {} / 只有 get 但取空 ⇒ 一律不抛（headless 兼容）
//   G ★护栏：不带 ?all=1 的整图重载**必须被拒**（400 且 rebuilt 一次都没被调用）；单行与显式 all 才放行
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = __dirname;
const results = [];
const add = (level, name, detail) => results.push({ level, name, detail: detail || '' });

function pkg() { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) } catch (e) { return null } }
function readVersion(file, re) { try { const m = fs.readFileSync(path.join(ROOT, file), 'utf8').match(re); return m ? m[1] : null } catch (e) { return null } }

function stubCtx() {
  const regs = [];
  const rebuilt = [];
  const graph = { entries: [{ id: 'pkg-a', rev: 'r1' }, { id: 'pkg-b', rev: 'r1' }] };
  const cm = { graph: () => graph, rebuilt: (id) => { rebuilt.push(id) } };
  const webServer = { register: (spec) => { regs.push(spec); return () => {} } };
  const ctx = {
    get: (k) => (k === 'webServer' ? webServer : (k === 'clientModules' ? cm : undefined)),
    effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
  };
  return { ctx, regs, rebuilt };
}

async function callHandler(spec, url, method) {
  let code = 0, body = '';
  const res = { writeHead: (c) => { code = c }, end: (b) => { body = String(b || '') } };
  const req = { url, method: method || 'GET', on: (ev, cb) => { if (ev === 'end') cb() } };
  await spec.handler(req, res);
  let json = null; try { json = JSON.parse(body) } catch (e) {}
  return { code, json, body };
}

async function main() {
  if (process.version < 'v20') add('WARN', 'Node 版本', '当前 ' + process.version + '，建议 ≥20')

  // A 包元数据
  const j = pkg();
  if (!j || !j.name || !j.version) add('FAIL', 'A 包元数据', 'package.json 不可解析或缺 name/version')
  else if (j.name !== 'dsh-hot-refresh') add('FAIL', 'A 包元数据', 'name 应为 dsh-hot-refresh，实为 ' + j.name)
  else add('PASS', 'A 包元数据', j.name + ' @ ' + j.version)

  // B 版本一致（宿主实现已搬到 lib/host/impl.js）
  const cv = readVersion('lib/client.js', /VERSION = '([0-9.]+)'/);
  const hv = readVersion('lib/host/impl.js', /const VERSION = '([0-9.]+)'/);
  const pv = j && j.version;
  if (!cv || !hv || !pv) add('FAIL', 'B 版本一致', '有一处读不到：package=' + pv + ' client=' + cv + ' host=' + hv)
  else if (cv !== pv || hv !== pv) add('FAIL', 'B 版本一致', '不一致：package=' + pv + ' client=' + cv + ' host=' + hv)
  else add('PASS', 'B 版本一致', pv + '（package / client / host 三处一致）')

  // H ★薄入口契约：宿主入口必须"按版本号动态导入实现"，否则改宿主代码就得重启 App
  try {
    const entry = fs.readFileSync(path.join(ROOT, 'lib/index.js'), 'utf8');
    const hasImpl = entry.indexOf('./host/impl.js') >= 0;
    const hasRev = entry.indexOf('?rev=') >= 0;
    const hasPkg = entry.indexOf('../package.json') >= 0;
    if (!hasImpl || !hasRev || !hasPkg) {
      add('FAIL', 'H 薄入口契约', 'lib/index.js 缺少按版本动态导入的三要素：impl=' + hasImpl + ' rev=' + hasRev + ' pkgVersion=' + hasPkg)
    } else add('PASS', 'H 薄入口契约', 'lib/index.js 按 package.json 版本动态导入 ./host/impl.js（版本一变即绕过 ESM 缓存）');
    // H2 ★客户端入口契约：exports 必须同时含 '.' 与 './client'
    //    依据：profile/node_modules 下已装副本正是这个映射；曾因改窄 exports 丢过 './client'（宿主/工具按该键解析客户端半体）
    try {
      const pkg2 = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
      const ex = pkg2.exports || {};
      if (!ex['.'] || !ex['./client']) add('FAIL', 'H 客户端入口契约', "exports 必须同时含 '.' 与 './client'，实为 " + JSON.stringify(ex));
      else add('PASS', 'H 客户端入口契约', "exports '.':" + ex['.'] + " · './client':" + ex['./client']);
    } catch (e2) { add('FAIL', 'H 客户端入口契约', String((e2 && e2.message) || e2)); }
  } catch (e) { add('FAIL', 'H 薄入口契约', String((e && e.message) || e)) }

  // C 语法
  for (const f of ['lib/index.js', 'lib/client.js']) {
    const r = cp.spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
    if (r.status !== 0) add('FAIL', 'C 语法 ' + f, String(r.stderr || '').split('\n').slice(0, 3).join(' '))
    else add('PASS', 'C 语法 ' + f, 'exit 0')
  }

  // D 客户端形状夹具
  const fx = cp.spawnSync(process.execPath, [path.join(ROOT, '_check-client.cjs')], { encoding: 'utf8' });
  if (fx.status !== 0) add('FAIL', 'D 客户端形状夹具', String(fx.stdout || '').trim().split('\n').slice(-2).join(' '))
  else add('PASS', 'D 客户端形状夹具', 'exit 0')

  // E/F/G 宿主半体
  let mod = null;
  try { mod = await import(pathToFileURL(path.join(ROOT, 'lib/index.js')).href) } catch (e) { add('FAIL', 'E 宿主半体导入', String((e && e.message) || e)) }
  if (mod) {
    if (typeof mod.apply !== 'function') add('FAIL', 'E 宿主半体导出', '缺少 apply')
    if (mod.apply && mod.apply.constructor && mod.apply.constructor.name !== 'AsyncFunction') {
      add('FAIL', 'E 宿主半体导出', 'apply 应为 async（薄入口需 await 动态导入），实为 ' + mod.apply.constructor.name)
    }
    if (!Array.isArray(mod.inject) || mod.inject.indexOf('webServer') < 0) add('FAIL', 'E 宿主半体导出', "inject 应含 'webServer'")

    const s1 = stubCtx();
    try { await mod.apply(s1.ctx) } catch (e) { add('FAIL', 'E apply 首次', '抛错：' + ((e && e.message) || e)) }
    if (s1.regs.length !== 1) add('FAIL', 'E 路由注册', 'apply 一次应注册 1 条路由，实为 ' + s1.regs.length)
    else if (s1.regs[0].path !== '/hot-refresh') add('FAIL', 'E 路由注册', 'path 应为 /hot-refresh，实为 ' + s1.regs[0].path)
    else add('PASS', 'E 路由注册', 'path=' + s1.regs[0].path + ' kind=' + s1.regs[0].kind)

    if (s1.regs.length === 1) {
      const spec = s1.regs[0];
      const h = await callHandler(spec, '/hot-refresh/health');
      if (h.code !== 200) add('FAIL', 'E /health', 'HTTP ' + h.code)
      else if (!h.json || h.json.ok !== true) add('FAIL', 'E /health', 'ok 不为真')
      else if (h.json.rows !== 2) add('FAIL', 'E /health', 'rows 应为桩图的 2，实为 ' + h.json.rows)
      else if (h.json.applies !== 1) add('FAIL', 'E /health 幂等计数', 'applies 应为 1，实为 ' + h.json.applies)
      else if (h.json.version !== pv) add('FAIL', 'E /health 版本', 'version 应为 ' + pv + '，实为 ' + h.json.version)
      else add('PASS', 'E /health', 'rows=2 version=' + h.json.version + ' applies=1')

      // G ★护栏：不带 all 的整图重载必须被拒，且一次 rebuilt 都不许发生
      const g1 = await callHandler(spec, '/hot-refresh/reload');
      if (g1.code !== 400) add('FAIL', 'G 护栏（整图需显式）', '不带 all 应 400，实为 ' + g1.code)
      else if (!g1.json || g1.json.reason !== 'need-explicit-all') add('FAIL', 'G 护栏（整图需显式）', 'reason 应为 need-explicit-all，实为 ' + (g1.json && g1.json.reason))
      else if (s1.rebuilt.length !== 0) add('FAIL', 'G 护栏（整图需显式）', '被拒的请求竟然调了 rebuilt：' + s1.rebuilt.join(','))
      else add('PASS', 'G 护栏（整图需显式）', '400 ' + g1.json.reason + ' · rebuilt 调用 0 次（真的挡住了）')

      // 单行放行
      const g2 = await callHandler(spec, '/hot-refresh/reload?id=pkg-a');
      if (g2.code !== 200) add('FAIL', 'G 单行重载', 'HTTP ' + g2.code)
      else if (s1.rebuilt.length !== 1 || s1.rebuilt[0] !== 'pkg-a') add('FAIL', 'G 单行重载', 'rebuilt 调用应为 [pkg-a]，实为 [' + s1.rebuilt.join(',') + ']')
      else add('PASS', 'G 单行重载', 'rebuilt=[' + s1.rebuilt.join(',') + ']')

      // 显式 all 放行
      const g3 = await callHandler(spec, '/hot-refresh/reload?all=1');
      if (g3.code !== 200) add('FAIL', 'G 显式整图', 'HTTP ' + g3.code)
      else if (s1.rebuilt.length !== 3) add('FAIL', 'G 显式整图', '累计 rebuilt 应为 3（1 单行 + 2 整图），实为 ' + s1.rebuilt.length)
      else add('PASS', 'G 显式整图', '累计 rebuilt=' + s1.rebuilt.length + '（1 单行 + 2 整图）')

      // 未知 id 必须显形，不许静默成功
      const g4 = await callHandler(spec, '/hot-refresh/reload?id=nope');
      if (g4.code !== 503 || !g4.json || g4.json.reason !== 'unknown-id') add('FAIL', 'G 未知 id', '应 503/unknown-id，实为 ' + g4.code + '/' + (g4.json && g4.json.reason))
      else add('PASS', 'G 未知 id', '503 unknown-id（不静默成功）')
    }

    // ★ v0.4.0：精确重载（?ids=）与 graph 暴露 —— 用**全新的桩**，避免与上面的计数纠缠
    const s3 = stubCtx();
    try { await mod.apply(s3.ctx) } catch (e) { add('FAIL', 'H ids apply', String((e && e.message) || e)) }
    const spec3 = s3.regs[0];
    if (!spec3) add('FAIL', 'H ?ids 路由', 'apply 没有注册路由')
    else {
      const h3 = await callHandler(spec3, '/hot-refresh/health');
      const g = h3.json && h3.json.graph;
      if (!Array.isArray(g) || g.length !== 2 || !g[0].id || !('rev' in g[0])) {
        add('FAIL', 'H graph 暴露', 'graph 应为 [{id,rev}] 两行，实为 ' + JSON.stringify(g))
      } else add('PASS', 'H graph 暴露', 'graph=[{id,rev}]×' + g.length + '（客户端据此差分"哪些变了"）')

      const q1 = await callHandler(spec3, '/hot-refresh/reload?ids=pkg-a');
      if (q1.code !== 200 || !q1.json || (q1.json.done || []).length !== 1 || q1.json.done[0] !== 'pkg-a') {
        add('FAIL', 'H ?ids 精确重载', '应 200 done=[pkg-a]，实为 ' + q1.code + ' ' + JSON.stringify(q1.json && q1.json.done))
      } else if (s3.rebuilt.length !== 1) add('FAIL', 'H ?ids 精确重载', 'rebuilt 调用数应为 1，实为 ' + s3.rebuilt.length)
      else add('PASS', 'H ?ids 精确重载', 'done=[pkg-a] · rebuilt 恰好 1 次（不碰其它行）')

      const q2 = await callHandler(spec3, '/hot-refresh/reload?ids=pkg-b,nope');
      if (q2.code !== 503 || !q2.json || q2.json.reason !== 'unknown-id') {
        add('FAIL', 'H ?ids 未知 id', '应 503/unknown-id，实为 ' + q2.code + '/' + (q2.json && q2.json.reason))
      } else if ((q2.json.done || []).length !== 0 || s3.rebuilt.length !== 1) {
        add('FAIL', 'H ?ids 未知 id', '含未知 id 时必须先校验后执行（一条都不许重载），实为 done=' + JSON.stringify(q2.json.done))
      } else add('PASS', 'H ?ids 未知 id', '503 unknown-id · 一条都没重载（先校验后执行）')

      const q3 = await callHandler(spec3, '/hot-refresh/reload?ids=');
      if (q3.code !== 400 || !q3.json || q3.json.reason !== 'need-explicit-all') {
        add('FAIL', 'H ?ids 空', '空 ids 应退回 need-explicit-all(400)，实为 ' + q3.code + '/' + (q3.json && q3.json.reason))
      } else add('PASS', 'H ?ids 空', '400 need-explicit-all（空列表不得被当成"全部"）')
    }

    // E-replay：HMR 会重放 apply ⇒ 不许抛；计数必须可观测（重复注册的第一现场证据）
    // ★ 用**相对增量**断言（不能写死 2）：本文件里 apply 会被多个桩各调一次，写死数字会随测试增删而假红。
    const before3 = s1.regs.length === 1 ? (await callHandler(s1.regs[0], '/hot-refresh/health')).json : null;
    const s2 = stubCtx();
    try { await mod.apply(s2.ctx) } catch (e) { add('FAIL', 'E apply 重放', '第二次 apply 抛错：' + ((e && e.message) || e)) }
    const h2 = s2.regs.length === 1 ? await callHandler(s2.regs[0], '/hot-refresh/health') : null;
    if (s2.regs.length !== 1) add('FAIL', 'E apply 重放', '每次 apply 应各注册 1 条，实为 ' + s2.regs.length)
    else if (!before3 || !h2 || !h2.json) add('FAIL', 'E apply 重放计数', '读不到 applies')
    else if (h2.json.applies !== before3.applies + 1) add('FAIL', 'E apply 重放计数', 'applies 应每 apply +1：' + before3.applies + ' → ' + h2.json.applies)
    else add('PASS', 'E apply 重放', '第二次不抛 · applies ' + before3.applies + '→' + h2.json.applies + '（每次 apply 恰好 +1，重放可观测）')

    // F 敌意 ctx
    const hostile = [
      ['undefined', undefined],
      ['null', null],
      ['{}', {}],
      ['只有 get 但取空', { get: () => undefined, effect: (f) => f() }],
    ];
    let fBad = null;
    for (const [label, c] of hostile) {
      try { await mod.apply(c) } catch (e) { fBad = label + ' 抛错：' + ((e && e.message) || e); break }
    }
    if (fBad) add('FAIL', 'F 敌意 ctx', fBad)
    else add('PASS', 'F 敌意 ctx', hostile.length + ' 种（含 headless 无 webServer）一律不抛')
  }

  // 汇总
  const order = { FAIL: 0, WARN: 1, PASS: 2, INFO: 3 };
  results.sort((a, b) => order[a.level] - order[b.level]);
  console.log('  dsh-hot-refresh · 升级/重启前必过门');
  for (const r of results) console.log('   [' + r.level + '] ' + r.name + (r.detail ? ' —— ' + r.detail : ''));
  const n = { PASS: 0, WARN: 0, FAIL: 0, INFO: 0 };
  for (const r of results) n[r.level]++;
  console.log('  合计 ' + results.length + ' 项：PASS ' + n.PASS + ' · WARN ' + n.WARN + ' · FAIL ' + n.FAIL + (n.INFO ? ' · INFO ' + n.INFO : ''));
  if (n.FAIL) { console.log('  ⇒ 先不要动这张插件图：有 ' + n.FAIL + ' 项 FAIL'); process.exit(1) }
  console.log('  ⇒ 可以安全安装/升级（无 FAIL）');
}

main().catch((e) => { console.error('  门自身崩了：' + ((e && e.stack) || e)); process.exit(1) });
