// dsh-hot-refresh —— 客户端半体 v0.2.0
//
// 作用：把"改完插件要按 F5"变成面板上一个按钮；**不自己实现模块替换**（那是官方
// @deepseek-ai/dsh-client-hmr + dsh-client-modules 的活），只做"触发 + 可观测"。
//
// v0.2.0 三处变化：
//   ① **整图重载加护栏**：底部按钮首点是"待确认"（按钮文字直接写出影响面：会重载 N 行、
//      所有插件的 React 状态会丢），5 秒内再点一次才真发 `?all=1`。插件详情页的
//      「就地重载」仍是单行即时（安全）。
//   ② **版本握手**：挂载时读一次 `/hot-refresh/health` 的 `version`；宿主版本与客户端不一致
//      就在按钮上标黄并写明（避免"看起来按了却没效果"这类跨版本误解），并随自报上报。
//   ③ **自报更完整**：mount/reload 都带 `hostVersion` 与 `rows`，从服务端 `/health` 的
//      `reports` 就能核验"按钮在不在、按了成没成、当时是哪个版本"。
window.__ModuleLoader__.load({
  id: 'dsh-hot-refresh',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var React = require('react');
    var h = React.createElement;

    var VERSION = '0.4.0';
    var FOOTER_ID = 'hot-refresh';
    var FOOTER_ORDER = 50;
    var DETAIL_ID = 'hot-refresh-row';
    var DETAIL_ORDER = 40;
    var CSS_ID = 'dsh-hot-refresh/styles';
    var ARM_MS = 5000;
    // ★ v0.4.0：记住"上次见过的各行 rev" ⇒ 用来算"自上次之后有几个插件变了"，
    //   从而**只重载变化的那几行**（单行重载不丢整图 React 状态），不再动不动整图重载。
    var REVS_KEY = 'dsh-hot-refresh:revs:v1';

    var inject = ['slots'];

    var CSS = [
      '.hr-btn{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;',
      'font-size:12px;line-height:1;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));',
      'border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-secondary,inherit);',
      'cursor:pointer;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}',
      '.hr-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,inherit)}',
      '.hr-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary,#3b82f6);outline-offset:1px}',
      '.hr-btn[disabled]{opacity:.6;cursor:default}',
      '.hr-btn.hr-bad{border-color:var(--dsw-alias-state-warning-primary,#d97706);color:var(--dsw-alias-state-warning-primary,#d97706)}',
      '.hr-btn.hr-armed{border-color:var(--dsw-alias-state-warning-primary,#d97706);color:var(--dsw-alias-state-warning-primary,#d97706)}',
    ].join('');

    function ensureCss() {
      try {
        if (document.getElementById(CSS_ID)) return;
        var s = document.createElement('style');
        s.id = CSS_ID;
        s.textContent = CSS;
        document.head.appendChild(s);
      } catch (e) {}
    }

    function safe(fn, label) {
      try { return fn() } catch (e) {
        try { console.error('[hot-refresh] ' + label + ' 失败（已隔离）：' + ((e && e.message) || e)) } catch (_) {}
        return null;
      }
    }

    function post(path, cb) {
      try {
        var p = fetch(path, { method: 'POST' });
        if (!p || typeof p.then !== 'function') { cb(new Error('无 fetch')); return }
        p.then(function (r) {
          return r.json().catch(function () { return null }).then(function (j) { return { s: r.status, j: j } });
        }).then(function (x) { cb(null, x) }).catch(function (e) { cb(e) });
      } catch (e) { cb(e) }
    }

    // 自报：不静默失败 —— GET /hot-refresh/health 的 reports 里能看到"按过、成没成、什么版本"。
    function report(o) {
      safe(function () {
        var body = JSON.stringify(Object.assign({ version: VERSION }, o || {}));
        var p = fetch('/hot-refresh/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body });
        if (p && typeof p.catch === 'function') p.catch(function () {});
      }, 'report');
    }

    // 宿主机状态（版本握手 + 行数 + 图）：挂载时读一次；读不到就不标黄、不阻塞界面。
    var HOST = { version: '', rows: 0, at: 0, graph: [], changed: [] };
    function readHost() {
      safe(function () {
        var p = fetch('/hot-refresh/health');
        if (!p || typeof p.then !== 'function') return;
        p.then(function (r) { return r.json ? r.json() : null }).then(function (j) {
          if (!j) return;
          HOST.version = String(j.version || '');
          HOST.rows = Number(j.rows) || 0;
          HOST.at = Date.now();
          HOST.graph = graphOf(j);
          HOST.changed = diffRevs(loadRevs(), HOST.graph);      // ★ v0.4.0
          if (HOST.version && HOST.version !== VERSION) report({ action: 'version-mismatch', ok: false, hostVersion: HOST.version, rows: HOST.rows });
        }).catch(function () {});
      }, 'readHost');
    }

    function subjectId(props) {
      try {
        var s = props && (props.subject || props.row || props.plugin || props.item);
        if (s) return String(s.id || s.moduleName || s.name || s.packageName || '');
        return String((props && (props.id || props.moduleName)) || '');
      } catch (e) { return '' }
    }

    // ── ★ v0.4.0：rev 差分（纯函数，便于夹具直接断言）──
    // graph 形如 [{id, rev}]；prev 形如 {id: rev}。返回"新增或 rev 变了"的 id 列表。
    function diffRevs(prev, graph) {
      try {
        var out = [];
        var seen = {};
        var list = Array.isArray(graph) ? graph : [];
        for (var i = 0; i < list.length; i++) {
          var row = list[i] || {};
          var id = String(row.id || '');
          if (!id) continue;
          seen[id] = 1;
          var rev = String(row.rev == null ? '' : row.rev);
          var old = prev ? prev[id] : undefined;
          if (old === undefined) out.push(id);                 // 新出现的行
          else if (String(old) !== rev) out.push(id);          // rev 变了
        }
        return out;
      } catch (e) { return [] }
    }
    function loadRevs() {
      try {
        var raw = window.localStorage.getItem(REVS_KEY);
        if (!raw) return {};
        var j = JSON.parse(raw);
        return (j && typeof j === 'object') ? j : {};
      } catch (e) { return {} }
    }
    function saveRevs(map) {
      try {
        var out = {};
        var n = 0;
        for (var k in (map || {})) {
          if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
          if (n >= 500) break;                                  // 有界：最多留 500 行
          out[String(k)] = String(map[k] == null ? '' : map[k]);
          n += 1;
        }
        window.localStorage.setItem(REVS_KEY, JSON.stringify(out));
        return n;
      } catch (e) { return 0 }
    }
    function revMapOf(graph) {
      var m = {};
      var list = Array.isArray(graph) ? graph : [];
      for (var i = 0; i < list.length; i++) {
        var row = list[i] || {};
        if (row.id != null) m[String(row.id)] = String(row.rev == null ? '' : row.rev);
      }
      return m;
    }
    // 从 /health 的响应里取"图"（新宿主给 graph；旧宿主只给 ids ⇒ rev 视为未知，仅在首次记录时视为已知）
    function graphOf(j) {
      try {
        if (j && Array.isArray(j.graph)) return j.graph.map(function (r) { return { id: String((r && r.id) || ''), rev: String((r && r.rev) == null ? '' : r.rev) } });
        if (j && Array.isArray(j.ids)) return j.ids.map(function (id) { return { id: String(id || ''), rev: '' } });
        return [];
      } catch (e) { return [] }
    }

    // ★ v0.4.0 兼容闸门：只有宿主 ≥ 0.4.0 才认识 ?ids= 精确重载。
    //   旧宿主（如仍在跑的 0.1.0）**不认识该参数会退回"整图重载"** ⇒ 会把整页 React 状态抹掉。
    //   所以客户端必须先比版本：不支持就继续走"二次确认 + ?all=1"的老路（对旧宿主是显式意图）。
    function cmpVersion(a, b) {
      try {
        var pa = String(a || '').split('.').map(function (x) { return parseInt(x, 10) || 0 });
        var pb = String(b || '').split('.').map(function (x) { return parseInt(x, 10) || 0 });
        var n = Math.max(pa.length, pb.length);
        for (var i = 0; i < n; i++) {
          var x = pa[i] || 0, y = pb[i] || 0;
          if (x !== y) return x > y ? 1 : -1;
        }
        return 0;
      } catch (e) { return -1 }
    }
    var IDS_MIN_HOST = '0.4.0';
    function hostSupportsIds() { return !!(HOST.version && cmpVersion(HOST.version, IDS_MIN_HOST) >= 0) }

    function sendReload(path, meta, set, onDone) {
      post(path, function (err, x) {
        set.busy(false);
        if (err || !x || x.s < 200 || x.s >= 300) {
          var j = x && x.j;
          var why = (j && j.reason) || (err && err.message) || ('HTTP ' + (x && x.s)) || '未知';
          var extra = j && j.rows != null ? ('（影响 ' + j.rows + ' 行）') : '';
          set.text('失败：' + why + extra); set.bad(true);
          report(Object.assign({ action: 'reload', ok: false, detail: String(why), hostVersion: HOST.version, rows: HOST.rows }, meta));
          if (onDone) safe(function () { onDone(false) }, 'onDone');
          return;
        }
        var j2 = x.j || {};
        var n = (j2.done || []).length, f = (j2.failed || []).length;
        set.text('已重载 ' + n + ' 个' + (f ? ('，失败 ' + f) : '')); set.bad(f > 0);
        report(Object.assign({ action: 'reload', ok: f === 0, done: n, failed: f, hostVersion: HOST.version, rows: HOST.rows }, meta));
        if (onDone) safe(function () { onDone(f === 0) }, 'onDone');
        try { window.setTimeout(function () { set.text('') }, 4000) } catch (e) {}
      });
    }

    function useReload() {
      var busy = React.useState(false), isBusy = busy[0], setBusy = busy[1];
      var msg = React.useState(''), text = msg[0], setText = msg[1];
      var bad = React.useState(false), isBad = bad[0], setBad = bad[1];
      var st = { busy: setBusy, text: setText, bad: setBad };
      return { isBusy: isBusy, text: text, isBad: isBad, st: st };
    }

    // ── 设置旁边（全局）：一键热刷新 ──
    // v0.4.0 行为：**已知有变化 ⇒ 只重载那几行**（安全、不丢整图状态）；无变化时才走"整图重载（需二次确认）"。
    function FooterButton(props) {
      var r = useReload();
      var a = React.useState(false), armed = a[0], setArmed = a[1];
      var timer = React.useRef(0);
      React.useEffect(function () {
        readHost();
        return function () { try { if (timer.current) window.clearTimeout(timer.current) } catch (e) {} };
      }, []);
      function onClick(e) {
        try { e.preventDefault() } catch (_) {}
        if (r.isBusy) return;
        var changed = HOST.changed || [];
        var idsOk = hostSupportsIds();
        if (changed.length && idsOk) {                          // ★ 只重载变化的那几行（需宿主 ≥0.4.0）
          setArmed(false);
          r.st.busy(true); r.st.text('重载中…'); r.st.bad(false);
          sendReload('/hot-refresh/reload?ids=' + encodeURIComponent(changed.join(',')), { ids: changed, all: false }, r.st, function (ok) {
            if (ok) { saveRevs(revMapOf(HOST.graph)); HOST.changed = []; }
          });
          return;
        }
        if (!armed) {                                           // 无变化 ⇒ 整图重载需二次确认
          setArmed(true);
          try { if (timer.current) window.clearTimeout(timer.current) } catch (_) {}
          try { timer.current = window.setTimeout(function () { setArmed(false) }, ARM_MS) } catch (_) {}
          return;
        }
        setArmed(false);
        try { if (timer.current) window.clearTimeout(timer.current) } catch (_) {}
        r.st.busy(true); r.st.text('重载中…'); r.st.bad(false);
        sendReload('/hot-refresh/reload?all=1', { id: '', all: true }, r.st, function (ok) {
          if (ok) { saveRevs(revMapOf(HOST.graph)); HOST.changed = []; }
        });
      }
      var mismatch = HOST.version && HOST.version !== VERSION;
      var n = (HOST.changed || []).length;
      var idsOk = hostSupportsIds();
      var label = armed
        ? ('再点一次＝重载全部' + (HOST.rows ? (' ' + HOST.rows + ' 行') : '') + '（插件状态会丢）')
        : (n && idsOk ? ('⟳ 热刷新 · ' + n + ' 个已变')
          : (n ? ('⟳ 热刷新 · ' + n + ' 个已变（宿主 ' + (HOST.version || '?') + ' 不支持精确重载）') : ('⟳ 热刷新' + (r.text ? (' · ' + r.text) : '') + (mismatch ? ' · 宿主 ' + HOST.version : ''))));
      return h('button', {
        className: 'hr-btn' + (r.isBad || mismatch ? ' hr-bad' : '') + (armed ? ' hr-armed' : ''),
        type: 'button', disabled: r.isBusy,
        title: (mismatch ? ('宿主半体版本 ' + HOST.version + ' 与客户端 ' + VERSION + ' 不一致：界面能用，但若行为不符请重装/重启一次（宿主 ≥' + IDS_MIN_HOST + ' 才支持只重载变化行）\n') : '')
          + (n ? ('检测到 ' + n + ' 个插件的客户端 bundle 变了：' + (idsOk ? '点一下只重载这几个（不碰其它插件）' : '但当前宿主不支持精确重载 ⇒ 仍走整图重载（需二次确认）') + '\n' + HOST.changed.slice(0, 8).join('、') + (n > 8 ? ' …' : ''))
               : '点一次＝待确认；5 秒内再点一次＝重载整张客户端插件图（调 clientModules.rebuilt；状态会丢，会话/连接不受影响）'),
        onClick: onClick,
      }, label);
    }

    // ── 插件详情页头部：只重载这一个（单行、即时、无状态损失面）──
    function DetailButton(props) {
      var r = useReload();
      var id = subjectId(props);
      React.useEffect(function () { readHost() }, []);
      return h('button', {
        className: 'hr-btn' + (r.isBad ? ' hr-bad' : ''), type: 'button', disabled: r.isBusy,
        title: id ? ('只重载 ' + id + ' 这一行的客户端半体（不碰其它插件）') : '没认出这一行的 id ⇒ 点它会提示先重装/改用底部「热刷新」',
        onClick: function (e) {
          try { e.preventDefault() } catch (_) {}
          if (!id) { r.st.bad(true); r.st.text('认不出本行 id'); report({ action: 'reload', ok: false, detail: 'no-subject-id', hostVersion: HOST.version }); return }
          r.st.busy(true); r.st.text('重载中…'); r.st.bad(false);
          sendReload('/hot-refresh/reload?id=' + encodeURIComponent(id), { id: id, all: false }, r.st);
        },
      }, '⟳ 就地重载' + (id ? '' : '（需先识别）') + (r.text ? (' · ' + r.text) : ''));
    }

    function guard(label, fn) {
      try { return fn() } catch (e) {
        try { console.error('[hot-refresh] ' + label + ' 失败（已隔离）：' + ((e && e.message) || e)) } catch (_) {}
        return null;
      }
    }

    function apply(ctx) {
      ensureCss();
      var slots = safe(function () { return ctx && ctx.slots }, 'ctx.slots');
      if (!slots || typeof slots.register !== 'function') {
        try { console.error('[hot-refresh] ctx.slots 不可用 ⇒ 本插件不注册，宿主不受影响') } catch (e) {}
        return function () {};
      }
      var disposers = [];
      var d1 = guard('注册面板底部「热刷新」', function () {
        return slots.inject('sidebar.footer.action', function () {
          return slots.register({ name: 'sidebar.footer.action', id: FOOTER_ID, order: FOOTER_ORDER, label: function () { return '热刷新' } }, FooterButton);
        });
      });
      if (d1) disposers.push(d1);
      var d2 = guard('注册插件详情页「就地重载」', function () {
        return slots.inject('plugins.detail.actions', function () {
          return slots.register({ name: 'plugins.detail.actions', id: DETAIL_ID, order: DETAIL_ORDER, label: function () { return '就地重载' } }, DetailButton);
        });
      });
      if (d2) disposers.push(d2);
      // 版本握手要尽早（HMR 重载后也可能走到这里）
      readHost();
      report({ action: 'mount', ok: !!(d1 || d2), slots: [d1 ? 'sidebar.footer.action' : null, d2 ? 'plugins.detail.actions' : null].filter(Boolean), hostVersion: HOST.version });
      return function () { for (var i = 0; i < disposers.length; i++) { try { disposers[i]() } catch (e) {} } };
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = 'hot-refresh';
    exports.__hot = { VERSION: VERSION, subjectId: subjectId, CSS: CSS, report: report, HOST: HOST, diffRevs: diffRevs, loadRevs: loadRevs, saveRevs: saveRevs, revMapOf: revMapOf, graphOf: graphOf, cmpVersion: cmpVersion, IDS_MIN_HOST: IDS_MIN_HOST, REVS_KEY: REVS_KEY };
    return module.exports;
  }
});

//# sourceMappingURL=client.js.map
