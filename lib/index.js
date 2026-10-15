// dsh-hot-refresh —— 宿主侧**稳定入口**（极薄）v0.3.0
//
// 为什么这样切（这是本插件对自己做的"可热升级"改造）：
//   DSH 宿主半体是 Node ESM，**按 URL 缓存**。实测（2026-10-15）：改了 lib/index.js 之后
//   用插件管理器"停用 + 启用"（application: applied）**仍然跑旧代码** —— /health 照旧报旧版本号。
//   但 apply 是会被重放的。于是把真实现挪到 lib/host/impl.js，并让本入口按 **package.json 的版本号**
//   动态导入：`import('./host/impl.js?rev=<version>')`。**版本一变 URL 就变，模块缓存必然失效**
//   ⇒ "停用 + 启用"即可把新的宿主实现换上，不必重启 App。
//   （版本没变则命中缓存，不会重复加载、不会重复注册。）
//
// 兼容性：导入失败或实现缺 apply 时**只记日志、不抛**，绝不让宿主起不来。
import { readFileSync } from 'node:fs'

export const name = 'hot-refresh'
export const inject = ['webServer']

function version() {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    return String(JSON.parse(raw).version || '0')
  } catch (e) { return '0' }
}

export async function apply(ctx) {
  const v = version()
  let mod = null
  try {
    mod = await import(new URL('./host/impl.js?rev=' + encodeURIComponent(v), import.meta.url).href)
  } catch (e) {
    try { console.error('[hot-refresh] 宿主实现导入失败（已隔离，宿主不受影响）：' + ((e && e.message) || e)) } catch (_) {}
    return
  }
  if (!mod || typeof mod.apply !== 'function') {
    try { console.error('[hot-refresh] 宿主实现缺少 apply（已隔离）') } catch (_) {}
    return
  }
  return await mod.apply(ctx)
}
