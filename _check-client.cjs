// _check-client.cjs —— 客户端半体夹具（桩掉 React / 模块加载器 / 网络 / document，不跑真界面）
//
// ★ 血泪教训（本仓库实测）：模块里调用的是**裸 `fetch` / `document` / `setTimeout`**（浏览器里＝window.*），
//   所以桩必须打在 **globalThis** 上；打在「window 对象」上会被 Node 22 的全局实现接管，
//   表现为"夹具全绿但其实什么都没测到"（旧版夹具就栽在这里）。
//
// 判据：
//   ① 模块导出形状（id/factory/无 default/具名 apply+inject+name）
//   ② 两个槽位都被注册（名称与 id 正确）+ disposer 可用
//   ③ 5 种敌意 ctx 一律不抛
//   ④ 文案与调用点齐全（热刷新 / 两个端点）
//   ⑤ 幂等：apply 两次，CSS 只注入一次（不得重复插样式）
//   ⑥ ★版本握手：宿主版本与客户端不一致 ⇒ 必须上报 version-mismatch
//   ⑦ ★版本一致 ⇒ 不得误报 version-mismatch
//   ⑧ ★subjectId 鲁棒：subject/row/plugin/item 四种形状 + 空值都能取到或安全返回空
//   ⑨ 注册计数：apply 一次恰好注册 2 条（防止未来改成模块级注册导致累积）
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'lib/client.js'), 'utf8');
const bad = [];

function requireStub(id) {
  if (id === 'react') {
    return {
      createElement: function () { return { __el: Array.prototype.slice.call(arguments) } },
      useState: function (v) { return [v, function () {}] },
      useEffect: function () {}, useRef: function (v) { return { current: v } },
    };
  }
  throw new Error('unexpected require: ' + id);
}

/** 建一个受控环境：globalThis 上装 document/fetch/setTimeout 桩，返回模块与记录器。 */
function makeEnv(opts) {
  const rec = { styles: 0, reports: [], fetches: [] };
  const defs = { load: null };
  const health = (opts && opts.health) || { ok: true, version: '0.3.0', rows: 0 };
  const prev = { fetch: globalThis.fetch, document: globalThis.document, setTimeout: globalThis.setTimeout };

  globalThis.document = (function () {
    // ★ 桩必须有状态：真实文档里 getElementById 会命中上一次注入的样式。
    //   第一版桩的 getElementById 恒返回 null ⇒ ⑤ 判据误报"重复注入"（是桩的错，不是产品的错）。
    const nodes = {};
    return {
      getElementById: function (id) { return nodes[id] || null },
      createElement: function (tag) {
        const el = { tagName: tag, id: '', textContent: '', setAttribute: function () {}, appendChild: function () {} };
        if (tag === 'style') rec.styles += 1;
        return el;
      },
      head: { appendChild: function (el) { if (el && el.id) nodes[el.id] = el } },
    };
  })();
  globalThis.setTimeout = function () { return 0 };
  globalThis.fetch = function (url, o) {
    rec.fetches.push(String(url));
    if (String(url).indexOf('/report') >= 0) { try { rec.reports.push(JSON.parse(o && o.body)) } catch (e) { rec.reports.push(null) } }
    return Promise.resolve({
      ok: true, status: 200,
      json: function () { return Promise.resolve(health) },
      text: function () { return Promise.resolve(JSON.stringify(health)) },
      catch: function () {},
    });
  };

  const win = {
    __ModuleLoader__: { load: function (d) { defs.load = d } },
    console: { info: function () {}, error: function () {}, warn: function () {} },
    // 有状态 localStorage（模块用 window.localStorage 存取"上次见过的 rev"）
    localStorage: (function () {
      const store = {};
      return {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null },
        setItem: function (k, v) { store[k] = String(v) },
        removeItem: function (k) { delete store[k] },
      };
    })(),
  };
  let M = null;
  try { new Function('window', 'require', src)(win, requireStub) } catch (e) { bad.push('模块加载抛错：' + ((e && e.message) || e)) }
  if (defs.load) M = defs.load.factory(requireStub);
  return {
    win: win, M: M, rec: rec, loaded: defs.load,
    restore: function () { globalThis.fetch = prev.fetch; globalThis.document = prev.document; globalThis.setTimeout = prev.setTimeout; },
  };
}

function newCtx(regs) {
  return {
    slots: {
      inject: function (name, cb) { regs.push('inject:' + name); return cb() },
      register: function (spec) { regs.push('register:' + spec.name + '#' + spec.id); return function () {} },
    },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

async function main() {
  // ── ① 形状 ──
  const env0 = makeEnv({});
  try {
    if (!env0.loaded) bad.push('没有调用 window.__ModuleLoader__.load')
    else {
      if (env0.loaded.id !== 'dsh-hot-refresh') bad.push('模块 id 应为 dsh-hot-refresh，实为 ' + env0.loaded.id)
      if (typeof env0.loaded.factory !== 'function') bad.push('factory 不是函数')
    }
    const M0 = env0.M;
    if (!M0) bad.push('factory 没有返回模块')
    else {
      if (typeof M0.apply !== 'function') bad.push('缺少 exports.apply')
      if (typeof M0.name !== 'string' || !M0.name) bad.push('缺少 exports.name')
      if (!Array.isArray(M0.inject) || M0.inject.indexOf('slots') < 0) bad.push("exports.inject 应含 'slots'")
      if (M0.default) bad.push('不该有 exports.default（实测它会破坏加载）')
      if (!M0.__hot || !M0.__hot.VERSION) bad.push('缺少 __hot.VERSION（自检/版本上报用）')

      // ── ② 槽位 + ⑨ 注册计数 ──
      const regs = [];
      let d = null;
      try { d = M0.apply(newCtx(regs)) } catch (e) { bad.push('apply 抛错：' + ((e && e.message) || e)) }
      if (typeof d !== 'function') bad.push('apply 应返回 disposer 函数')
      if (regs.indexOf('register:sidebar.footer.action#hot-refresh') < 0) bad.push('没有注册 sidebar.footer.action#hot-refresh，实得：' + regs.join(' | '))
      if (regs.indexOf('register:plugins.detail.actions#hot-refresh-row') < 0) bad.push('没有注册 plugins.detail.actions#hot-refresh-row，实得：' + regs.join(' | '))
      const regCount = regs.filter((x) => x.indexOf('register:') === 0).length;
      if (regCount !== 2) bad.push('⑨ apply 一次应恰好注册 2 条，实为 ' + regCount + '（模块级注册会累积）');
      if (typeof d === 'function') { try { d() } catch (e) { bad.push('disposer 抛错：' + ((e && e.message) || e)) } }

      // ── ⑤ 幂等：apply 两次，样式只注入一次 ──
      const regs2 = [];
      try { M0.apply(newCtx(regs2)) } catch (e) { bad.push('第二次 apply 抛错：' + ((e && e.message) || e)) }
      if (env0.rec.styles !== 1) bad.push('⑤ 幂等失败：apply 两次应只注入 1 次样式，实为 ' + env0.rec.styles);

      // ── ⑥ 版本握手：宿主版本不一致 ⇒ 必须上报 version-mismatch ──
      // ★ 切 env 前必须 flush：`globalThis.fetch` 是共享的，**上一个 env 的异步上报会落进下一个 env 的记录器**
      //   （实测踩到：⑥ 读到 env0 的陈旧上报 0.3.0/rows 0，误判"握手上报错" —— 是夹具的错）。
      await flush(); await flush();
      const envA = makeEnv({ health: { ok: true, version: '9.9.9', rows: 3 } });
      try {
        envA.M.apply(newCtx([]));
        await flush(); await flush();
        const mm = envA.rec.reports.filter((r) => r && r.action === 'version-mismatch');
        if (!mm.length) bad.push('⑥ 握手失败：宿主 9.9.9 vs 客户端 ' + envA.M.__hot.VERSION + ' 未上报 version-mismatch')
        else if (mm[0].hostVersion !== '9.9.9') bad.push('⑥ 握手上报的 hostVersion 应为 9.9.9，实为 ' + JSON.stringify(mm[0].hostVersion) + '（全部上报：' + JSON.stringify(envA.rec.reports).slice(0, 300) + '）')
        if (!envA.rec.reports.some((r) => r && r.action === 'mount')) bad.push('⑥ 挂载自报缺失（mount 必须在 apply 时发出）')
      } finally { envA.restore() }

      // ── ⑦ 版本一致 ⇒ 不得误报 ──
      await flush(); await flush();
      const v = env0.M.__hot.VERSION;
      const envB = makeEnv({ health: { ok: true, version: v, rows: 1 } });
      try {
        envB.M.apply(newCtx([]));
        await flush(); await flush();
        if (envB.rec.reports.some((r) => r && r.action === 'version-mismatch')) bad.push('⑦ 版本一致却误报 version-mismatch（会制造假警报）')
      } finally { envB.restore() }

      // ── ★ v0.4.0：rev 差分 / 存储 / 版本闸门 ──
      const H = M0.__hot;
      if (!H || typeof H.diffRevs !== 'function') bad.push('⑩ 缺少 __hot.diffRevs（v0.4.0 精确重载的核心）')
      else {
        const prev = { a: 'r1', b: 'r1' };
        const g1 = [{ id: 'a', rev: 'r1' }, { id: 'b', rev: 'r2' }, { id: 'c', rev: 'r1' }];
        const ch = H.diffRevs(prev, g1);
        if (ch.length !== 2 || ch.indexOf('b') < 0 || ch.indexOf('c') < 0) bad.push('⑩ diffRevs 应为 [b,c]（rev 变了 + 新出现），实为 ' + JSON.stringify(ch))
        if (H.diffRevs(prev, [{ id: 'a', rev: 'r1' }, { id: 'b', rev: 'r1' }]).length !== 0) bad.push('⑩ diffRevs 全同 rev 时不该报变化（会制造假警报）')
        if (H.diffRevs({}, g1).length !== 3) bad.push('⑩ diffRevs 无历史（首次）时应全部视为"新"')
        if (H.diffRevs(prev, null).length !== 0 || H.diffRevs(null, null).length !== 0) bad.push('⑩ diffRevs 空输入应返回 [] 且不抛')
        const rm = H.revMapOf(g1);
        if (rm.a !== 'r1' || rm.b !== 'r2' || rm.c !== 'r1') bad.push('⑩ revMapOf 不对：' + JSON.stringify(rm))
        const go = H.graphOf({ graph: [{ id: 'x', rev: '9' }] });
        if (go.length !== 1 || go[0].id !== 'x' || go[0].rev !== '9') bad.push('⑩ graphOf 读新宿主 graph 失败')
        const gi = H.graphOf({ ids: ['y'] });
        if (gi.length !== 1 || gi[0].id !== 'y' || gi[0].rev !== '') bad.push('⑩ graphOf 读旧宿主 ids 的回退失败（向后兼容）')
        const n = H.saveRevs({ p: 'r1', q: 'r2' });
        if (n !== 2) bad.push('⑩ saveRevs 应写 2 条，实为 ' + n)
        const back = H.loadRevs();
        if (back.p !== 'r1' || back.q !== 'r2') bad.push('⑩ loadRevs 往返失败：' + JSON.stringify(back))
        const cv = H.cmpVersion;
        if (!cv) bad.push('⑩ 缺少 __hot.cmpVersion（版本闸门用）')
        else {
          if (cv('0.4.0', '0.3.0') !== 1 || cv('0.3.0', '0.4.0') !== -1 || cv('0.4.0', '0.4.0') !== 0) bad.push('⑩ cmpVersion 基本比较不对')
          if (cv('0.10.0', '0.9.0') !== 1) bad.push('⑩ cmpVersion 必须按数值段比（0.10.0 > 0.9.0），否则旧宿主会被误判为支持 ?ids')
          if (cv('', '0.4.0') !== -1 || cv(null, '0.4.0') !== -1) bad.push('⑩ cmpVersion 空/未知版本应视为更旧（安全侧）')
        }
        if (H.IDS_MIN_HOST !== '0.4.0') bad.push('⑩ IDS_MIN_HOST 应为 0.4.0，实为 ' + H.IDS_MIN_HOST)
      }
      if (src.indexOf('?ids=') < 0) bad.push('⑩ 客户端没有走 ?ids= 精确重载')
      if (src.indexOf('hostSupportsIds') < 0) bad.push('⑩ 缺少 hostSupportsIds 版本闸门（旧宿主会把 ?ids 当整图重载 ⇒ 抹掉整页状态）')

      const sid = M0.__hot.subjectId;
      const cases = [
        [{ subject: { moduleName: 'dsh-a' } }, 'dsh-a'],
        [{ row: { name: 'dsh-b' } }, 'dsh-b'],
        [{ plugin: { packageName: 'dsh-c' } }, 'dsh-c'],
        [{ id: 'dsh-d' }, 'dsh-d'],
        [{}, ''],
        [null, ''],
      ];
      for (const [input, want] of cases) {
        let got = null;
        try { got = sid(input) } catch (e) { bad.push('⑧ subjectId 抛错：' + ((e && e.message) || e)); continue }
        if (got !== want) bad.push('⑧ subjectId(' + JSON.stringify(input) + ') 应为 ' + JSON.stringify(want) + '，实为 ' + JSON.stringify(got))
      }
    }
  } finally { env0.restore() }

  // ── ③ 敌意 ctx 不抛 ──
  const hostile = [
    ['undefined', undefined], ['null', null], ['{}', {}],
    ['slots 无 register', { slots: {} }],
    ['slots.register 非函数', { slots: { register: 1, inject: function () {} } }],
  ];
  for (const [label, c] of hostile) {
    const envH = makeEnv({});
    try {
      const r = envH.M.apply(c);
      if (typeof r !== 'function') bad.push('敌意 ctx（' + label + '）应返回空 disposer')
    } catch (e) { bad.push('敌意 ctx（' + label + '）抛错：' + ((e && e.message) || e)) }
    finally { envH.restore() }
  }

  // ── ④ 文案与调用点 ──
  if (src.indexOf('热刷新') < 0) bad.push('客户端半体里找不到「热刷新」文案')
  if (src.indexOf('/hot-refresh/reload') < 0) bad.push('客户端半体没有调用 /hot-refresh/reload')
  if (src.indexOf('/hot-refresh/report') < 0) bad.push('客户端半体没有自报 /hot-refresh/report')
  if (src.indexOf('?all=1') < 0) bad.push('客户端半体没有走整图重载的显式 ?all=1（护栏要求）')

  if (bad.length) { console.error('✘ 客户端夹具失败：\n - ' + bad.join('\n - ')); process.exit(1) }
  console.log('✔ 客户端夹具通过：导出形状（id/factory/无 default） · 两槽位注册且一次恰好 2 条 · disposer 可用 · apply 两次只注入一次样式 · ★版本握手（不一致必须报 version-mismatch、一致不得误报） · ★subjectId 六种输入鲁棒 · ★v0.4.0 rev 差分（rev 变/新增/无历史/空输入）· ★存储往返（saveRevs/loadRevs）· ★graphOf 新旧宿主双形状回退 · ★cmpVersion 按数值段比较（0.10.0 > 0.9.0）· ★?ids= 精确重载与版本闸门齐备 · 5 种敌意 ctx 不抛 · 文案与调用点（含 ?all=1 护栏）齐全');
}

main().catch((e) => { console.error('✘ 夹具自身崩了：' + ((e && e.stack) || e)); process.exit(1) });
