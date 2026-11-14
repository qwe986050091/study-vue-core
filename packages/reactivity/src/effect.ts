// ============================================================================
// effect.ts：订阅者（Subscriber）的生命周期与批量调度
// ============================================================================
// 依赖图的“点”在 dep.ts，这里定义“边”的另一端：谁在消费依赖。
// 两类 Subscriber：
//   ReactiveEffect —— 用户 effect()/watch()/组件渲染 effect，重跑有副作用；
//   ComputedRefImpl —— computed，重跑只更新缓存值（见 computed.ts）。
// 两者共用 deps/depsTail/flags/notify 这套协议，因此本文件里的链表维护代码对二者
// 通用。
//
// 四个容易读错的地方，先点名：
//   1. activeSub 是全局单值而不是栈——嵌套靠 run() 里手动 save/restore（prevEffect）；
//   2. shouldTrack 也是全局单值，同样用 prevShouldTrack 保存/恢复；
//   3. notify() 只负责“排队”，真正执行在 endBatch()；computed 的 notify 甚至只标脏；
//   4. RUNNING 期间默认禁止自触发（ALLOW_RECURSE 豁免），这是 push 之类读写混合
//      方法不会死循环的原因。
// 与 MobX 的取舍差别（只提一句）：MobX 的 reaction 是显式的派发单元，Vue 的 effect
// 由 Proxy 在读属性时被动登记；批量在这里做，而 MobX 在事务边界做。
// ============================================================================

import { extend, hasChanged } from '@vue/shared'
import type { ComputedRefImpl } from './computed'
import type { TrackOpTypes, TriggerOpTypes } from './constants'
import { type Link, globalVersion } from './dep'
import { activeEffectScope } from './effectScope'
import { warn } from './warning'

export type EffectScheduler = (...args: any[]) => any

export type DebuggerEvent = {
  effect: Subscriber
} & DebuggerEventExtraInfo

export type DebuggerEventExtraInfo = {
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

export interface DebuggerOptions {
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
}

export interface ReactiveEffectOptions extends DebuggerOptions {
  scheduler?: EffectScheduler
  allowRecurse?: boolean
  onStop?: () => void
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

export let activeSub: Subscriber | undefined

// 位标志，用一个整数装下订阅者的全部状态。判断一律用位运算（x & flag），
// 置位用 |=，清位用 &= ~。逐条含义：
//   ACTIVE       还活着（stop() 后清掉），只有 effect 用
//   RUNNING      正在执行 fn，期间默认不允许被自己再次触发
//   TRACKING     是否参与依赖收集；computed 无下游时会关掉它以允许 GC
//   NOTIFIED     已进入待执行链表，防止同一轮重复排队
//   DIRTY        仅 computed：缓存可能过期，下次读时重算
//   ALLOW_RECURSE 允许在 RUNNING 时被自己触发（组件渲染 effect、watch 回调）
//   PAUSED       被 EffectScope.pause() 或 watchHandle.pause() 暂停
//   EVALUATED    computed 至少完整求值过一次
export enum EffectFlags {
  /**
   * ReactiveEffect only
   */
  ACTIVE = 1 << 0,
  RUNNING = 1 << 1,
  TRACKING = 1 << 2,
  NOTIFIED = 1 << 3,
  DIRTY = 1 << 4,
  ALLOW_RECURSE = 1 << 5,
  PAUSED = 1 << 6,
  EVALUATED = 1 << 7,
}

/**
 * Subscriber is a type that tracks (or subscribes to) a list of deps.
 */
export interface Subscriber extends DebuggerOptions {
  /**
   * Head of the doubly linked list representing the deps
   * @internal
   */
  // 订阅者视角的依赖链表头/尾：存的是 Link，不是 Dep。同一条 Link 在 dep 侧
  // 还挂在订阅者链表上（见 dep.ts 顶部说明）。
  deps?: Link
  /**
   * Tail of the same list
   * @internal
   */
  depsTail?: Link
  /**
   * @internal
   */
  flags: EffectFlags
  /**
   * @internal
   */
  // 批处理期间用作单链表指针，把订阅者串成待执行队列（见 batch）。
  next?: Subscriber
  /**
   * returning `true` indicates it's a computed that needs to call notify
   * on its dep too
   * @internal
   */
  notify(): true | void
}

const pausedQueueEffects = new WeakSet<ReactiveEffect>()

export class ReactiveEffect<T = any>
  implements Subscriber, ReactiveEffectOptions
{
  /**
   * @internal
   */
  deps?: Link = undefined
  /**
   * @internal
   */
  depsTail?: Link = undefined
  /**
   * @internal
   */
  flags: EffectFlags = EffectFlags.ACTIVE | EffectFlags.TRACKING
  /**
   * @internal
   */
  next?: Subscriber = undefined
  /**
   * @internal
   */
  cleanup?: () => void = undefined

  scheduler?: EffectScheduler = undefined
  onStop?: () => void
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void

  constructor(public fn: () => T) {
    // effect 在创建时归属当前活跃的 EffectScope（组件 setup 期间就是组件 scope），
    // 由 scope.stop() 统一清理，避免逐个手动 stop。
    if (activeEffectScope) {
      if (activeEffectScope.active) {
        activeEffectScope.effects.push(this)
      } else {
        // The active scope has already been stopped. This happens when a
        // component's setup is resumed after a top-level `await` (via the
        // compiler-emitted `__restore()` from `withAsyncContext`) but the
        // component was unmounted while pending under <Suspense>. Without
        // this guard the effect would become an orphan: not held by any
        // scope (so it cannot be stopped via the scope chain) yet still
        // able to subscribe to reactive deps and fire forever.
        // 关键点：不 push 进 scope，同时把自己标记为非 ACTIVE，这样即使后续 run()
        // 被调用也不会登记依赖（run 里 !ACTIVE 直接执行 fn、不收集）。
        this.flags &= ~EffectFlags.ACTIVE
      }
    }
  }

  pause(): void {
    // 只置标志，不停订阅；暂停期间被触发会记进 pausedQueueEffects（见 trigger）。
    this.flags |= EffectFlags.PAUSED
  }

  resume(): void {
    if (this.flags & EffectFlags.PAUSED) {
      this.flags &= ~EffectFlags.PAUSED
      // 暂停期间攒下的“曾经被触发”的信号在这里补一次。只补一次，不补次数，
      // 因为响应式系统只关心“最终值”，不关心中间触发了多少次。
      if (pausedQueueEffects.has(this)) {
        pausedQueueEffects.delete(this)
        this.trigger()
      }
    }
  }

  /**
   * @internal
   */
  notify(): void {
    // 自己正在跑又收到自己的触发：默认忽略（ALLOW_RECURSE 才放行）。典型案例
    // 是 effect 里调了 push()，push 内部会读 length，读的时候登记的依赖正是
    // 自己写的 length，不拦住就会自激。
    if (
      this.flags & EffectFlags.RUNNING &&
      !(this.flags & EffectFlags.ALLOW_RECURSE)
    ) {
      return
    }
    // NOTIFIED 去重：一次批量里同一个 effect 只排一次队。
    if (!(this.flags & EffectFlags.NOTIFIED)) {
      batch(this)
    }
  }

  run(): T {
    // TODO cleanupEffect

    if (!(this.flags & EffectFlags.ACTIVE)) {
      // stopped during cleanup
      // 已被 stop（或构造时 scope 已死）：只执行函数，不建立任何订阅。这样
      // “停止后仍被调用”不会把已死 effect 重新接回依赖图。
      return this.fn()
    }

    this.flags |= EffectFlags.RUNNING
    // 顺序有意义：先跑上一次注册的 cleanup（作用于上一轮），再 prepareDeps
    // 把旧依赖版本置 -1，然后才开始本轮求值。
    cleanupEffect(this)
    prepareDeps(this)
    const prevEffect = activeSub
    const prevShouldTrack = shouldTrack
    activeSub = this
    shouldTrack = true

    try {
      return this.fn()
    } finally {
      if (__DEV__ && activeSub !== this) {
        // 正常情况下 fn 内部的嵌套 run 会自己还原 activeSub；这里不等说明内部
        // 有异常路径没还原，属于框架 bug 而不是用户代码问题。
        warn(
          'Active effect was not restored correctly - ' +
            'this is likely a Vue internal bug.',
        )
      }
      // 无论 fn 抛不抛异常都要做：淘汰本轮没读到的依赖、还原全局求值上下文、
      // 清 RUNNING（否则 effect 永久禁止自触发）。
      cleanupDeps(this)
      activeSub = prevEffect
      shouldTrack = prevShouldTrack
      this.flags &= ~EffectFlags.RUNNING
    }
  }

  stop(): void {
    if (this.flags & EffectFlags.ACTIVE) {
      // 逐条摘链：同时从各 Dep 的订阅者链表中移除自己。复杂度是 O(依赖数)，
      // 这也是 stop 比“置个标志”更贵的原因。
      for (let link = this.deps; link; link = link.nextDep) {
        removeSub(link)
      }
      this.deps = this.depsTail = undefined
      cleanupEffect(this)
      this.onStop && this.onStop()
      this.flags &= ~EffectFlags.ACTIVE
    }
  }

  trigger(): void {
    // 三条出口，优先级从高到低：
    //   PAUSED   —— 只记信号，resume 时补一次；
    //   scheduler—— 有调度器就交给它（组件渲染 effect 的 scheduler 是 queueJob，
    //               watch 的 scheduler 是 job），由上层决定何时执行；
    //   直接跑    —— 没有调度器就立即执行，但还要先做脏检查。
    if (this.flags & EffectFlags.PAUSED) {
      pausedQueueEffects.add(this)
    } else if (this.scheduler) {
      this.scheduler()
    } else {
      this.runIfDirty()
    }
  }

  /**
   * @internal
   */
  runIfDirty(): void {
    // 为什么不无条件 run？同一批次里多个 dep 都变了，effect 只需跑一次；而且
    // 若变化的是自己不关心的 dep（依赖链在重跑时动态变化），跳过能省一次执行。
    if (isDirty(this)) {
      this.run()
    }
  }

  get dirty(): boolean {
    return isDirty(this)
  }
}

/**
 * For debugging
 */
// function printDeps(sub: Subscriber) {
//   let d = sub.deps
//   let ds = []
//   while (d) {
//     ds.push(d)
//     d = d.nextDep
//   }
//   return ds.map(d => ({
//     id: d.id,
//     prev: d.prevDep?.id,
//     next: d.nextDep?.id,
//   }))
// }

let batchDepth = 0
// 两个待执行链表：普通 effect 与 computed 分开。原因是执行语义不同——
// computed 在窗口关闭时只需要清掉 NOTIFIED（它的求值留给真正的读操作），
// effect 则需要真正调用 trigger()。
let batchedSub: Subscriber | undefined
let batchedComputed: Subscriber | undefined

export function batch(sub: Subscriber, isComputed = false): void {
  sub.flags |= EffectFlags.NOTIFIED
  // 头插法把订阅者压成单链表，因此链表顺序与通知顺序相反；endBatch 从头取出
  // 相当于后进先出。配合 dep.notify 的“尾→头”遍历，最终执行顺序回到原始顺序。
  if (isComputed) {
    sub.next = batchedComputed
    batchedComputed = sub
    return
  }
  sub.next = batchedSub
  batchedSub = sub
}

/**
 * @internal
 */
export function startBatch(): void {
  // 计数而不是布尔：嵌套 trigger 只有最外层关闭时才真正执行。
  batchDepth++
}

/**
 * Run batched effects when all batches have ended
 * @internal
 */
export function endBatch(): void {
  if (--batchDepth > 0) {
    return
  }

  // computed 先处理，且只清 NOTIFIED、不执行：computed 的惰性要求“没人读就
  // 不算”。标脏已经在 ComputedRefImpl.notify() 里完成，这里清标志是为了让它
  // 能在下一批里再次入队。
  if (batchedComputed) {
    let e: Subscriber | undefined = batchedComputed
    batchedComputed = undefined
    while (e) {
      const next: Subscriber | undefined = e.next
      e.next = undefined
      e.flags &= ~EffectFlags.NOTIFIED
      e = next
    }
  }

  // 执行普通 effect。注意异常策略：记录第一个错误、继续跑完其余 effect，
  // 最后再抛出。这样一次写入不会因为某个 effect 抛错而让其他 effect 漏跑。
  let error: unknown
  while (batchedSub) {
    let e: Subscriber | undefined = batchedSub
    batchedSub = undefined
    while (e) {
      const next: Subscriber | undefined = e.next
      e.next = undefined
      e.flags &= ~EffectFlags.NOTIFIED
      // ACTIVE 检查：排队之后、执行之前可能被 stop()，此时应跳过。
      if (e.flags & EffectFlags.ACTIVE) {
        try {
          // ACTIVE flag is effect-only
          ;(e as ReactiveEffect).trigger()
        } catch (err) {
          if (!error) error = err
        }
      }
      e = next
    }
  }

  if (error) throw error
}

function prepareDeps(sub: Subscriber) {
  // 重跑前的准备：把每条旧链接标记为“本轮尚未使用”，并把 Dep.activeLink
  // 换成这条链接（保存旧的以便还原，因为嵌套求值会共享同一个 dep）。
  for (let link = sub.deps; link; link = link.nextDep) {
    // set all previous deps' (if any) version to -1 so that we can track
    // which ones are unused after the run
    link.version = -1
    // store previous active sub if link was being used in another context
    // 这一步让 Dep.track() 的快路径在本轮可用；prevActiveLink 是“栈帧”的等价物。
    link.prevActiveLink = link.dep.activeLink
    link.dep.activeLink = link
  }
}

function cleanupDeps(sub: Subscriber) {
  // 从尾部往回扫：version 仍是 -1 的链接本轮没被访问，需要从两张链表里摘除。
  // 反向扫描是为了在删除节点的同时正确维护 head/tail。
  let head
  let tail = sub.depsTail
  let link = tail
  while (link) {
    const prev = link.prevDep
    if (link.version === -1) {
      if (link === tail) tail = prev
      // unused - remove it from the dep's subscribing effect list
      removeSub(link)
      // also remove it from this effect's dep list
      removeDep(link)
    } else {
      // The new head is the last node seen which wasn't removed
      // from the doubly-linked list
      // 反向扫时最后遇到的“未被删除”的节点就是新头。
      head = link
    }

    // restore previous active link if any
    // 恢复 dep.activeLink，等价于弹出 prepareDeps 压入的“栈帧”。
    link.dep.activeLink = link.prevActiveLink
    link.prevActiveLink = undefined
    link = prev
  }
  // set the new head & tail
  sub.deps = head
  sub.depsTail = tail
}

function isDirty(sub: Subscriber): boolean {
  // 脏检查 = 逐条比较“我上次读到的版本”与“dep 现在的版本”。
  // 遇到 computed 依赖时还要先把它刷新：computed 的 dep.version 只有在值真的
  // 变了时才自增，所以刷新后再比一次版本，避免“上游变了但 computed 输出没变”
  // 造成下游白跑。
  for (let link = sub.deps; link; link = link.nextDep) {
    if (
      link.dep.version !== link.version ||
      (link.dep.computed &&
        (refreshComputed(link.dep.computed) ||
          link.dep.version !== link.version))
    ) {
      return true
    }
  }
  // @ts-expect-error only for backwards compatibility where libs manually set
  // this flag - e.g. Pinia's testing module
  if (sub._dirty) {
    return true
  }
  return false
}

/**
 * Returning false indicates the refresh failed
 * @internal
 */
export function refreshComputed(computed: ComputedRefImpl): undefined {
  // 第一层快速返回：已经有人订阅（TRACKING）且不脏，缓存可直接用。
  // 注意反向条件：没有 TRACKING 的 computed 不受此保护，必须走后面的检查。
  if (
    computed.flags & EffectFlags.TRACKING &&
    !(computed.flags & EffectFlags.DIRTY)
  ) {
    return
  }
  computed.flags &= ~EffectFlags.DIRTY

  // Global version fast path when no reactive changes has happened since
  // last refresh.
  // 第二层：整个响应式世界自上次求值后没变过，连依赖都不用比。
  if (computed.globalVersion === globalVersion) {
    return
  }
  computed.globalVersion = globalVersion

  // In SSR there will be no render effect, so the computed has no subscriber
  // and therefore tracks no deps, thus we cannot rely on the dirty check.
  // Instead, computed always re-evaluate and relies on the globalVersion
  // fast path above for caching.
  // #12337 if computed has no deps (does not rely on any reactive data) and evaluated,
  // there is no need to re-evaluate.
  // 第三层：有依赖时用 isDirty 精确判断；无依赖（常量 computed）且已求值过就
  // 直接复用。SSR 例外：没有下游订阅者 → 没有 deps，只能依赖 globalVersion。
  if (
    !computed.isSSR &&
    computed.flags & EffectFlags.EVALUATED &&
    ((!computed.deps && !(computed as any)._dirty) || !isDirty(computed))
  ) {
    return
  }
  computed.flags |= EffectFlags.RUNNING

  // 求值期间把 activeSub 换成 computed 自己：getter 里读到的属性都会记到它的
  // deps 链表上。computed 的 dep.version 只在结果变化时自增，这是“值没变就
  // 不通知下游”的关键。
  const dep = computed.dep
  const prevSub = activeSub
  const prevShouldTrack = shouldTrack
  activeSub = computed
  shouldTrack = true

  try {
    prepareDeps(computed)
    const value = computed.fn(computed._value)
    // 首次求值（version === 0）无条件写缓存；之后只有 hasChanged 才自增版本，
    // 否则下游的 isDirty 会误判为脏。
    if (dep.version === 0 || hasChanged(value, computed._value)) {
      computed.flags |= EffectFlags.EVALUATED
      computed._value = value
      dep.version++
    }
  } catch (err) {
    // 异常也推进版本：下一次读不应该命中“值没变”的缓存。
    dep.version++
    throw err
  } finally {
    activeSub = prevSub
    shouldTrack = prevShouldTrack
    cleanupDeps(computed)
    computed.flags &= ~EffectFlags.RUNNING
  }
}

function removeSub(link: Link, soft = false) {
  // 从 Dep 的订阅者链表上摘掉一条边。soft=true 表示“软退订”：只摘指针，不减少
  // sub 计数、也不删空 Dep（见下方 computed 的递归软退订）。
  const { dep, prevSub, nextSub } = link
  if (prevSub) {
    prevSub.nextSub = nextSub
    link.prevSub = undefined
  }
  if (nextSub) {
    nextSub.prevSub = prevSub
    link.nextSub = undefined
  }
  if (__DEV__ && dep.subsHead === link) {
    // was previous head, point new head to next
    dep.subsHead = nextSub
  }

  if (dep.subs === link) {
    // was previous tail, point new tail to prev
    dep.subs = prevSub

    if (!prevSub && dep.computed) {
      // if computed, unsubscribe it from all its deps so this computed and its
      // value can be GCed
      // 这个 Dep 属于一个 computed，且它的下游订阅者已经清空：把 computed 自己
      // 从上游依赖里软退订，让整条 computed 链可以被回收。
      // 为什么是软退订：computed 仍保留 deps 链表（下次被读时还要用这些链接
      // 判断脏），只是不再参与上游通知。
      dep.computed.flags &= ~EffectFlags.TRACKING
      for (let l = dep.computed.deps; l; l = l.nextDep) {
        // here we are only "soft" unsubscribing because the computed still keeps
        // referencing the deps and the dep should not decrease its sub count
        removeSub(l, true)
      }
    }
  }

  if (!soft && !--dep.sc && dep.map) {
    // #11979
    // property dep no longer has effect subscribers, delete it
    // this mostly is for the case where an object is kept in memory but only a
    // subset of its properties is tracked at one time
    // 订阅者清零就把 Dep 从属性表里删掉，避免“对象长期存活、属性频繁换着读”
    // 导致 targetMap 里堆满一次性 Dep。
    dep.map.delete(dep.key)
  }
}

function removeDep(link: Link) {
  // 只处理订阅者侧的依赖链表（nextDep/prevDep）；dep 侧由 removeSub 负责。
  // 两者分开是因为 cleanupDeps 只摘订阅者侧，而 stop/软退订要同时摘 dep 侧。
  const { prevDep, nextDep } = link
  if (prevDep) {
    prevDep.nextDep = nextDep
    link.prevDep = undefined
  }
  if (nextDep) {
    nextDep.prevDep = prevDep
    link.nextDep = undefined
  }
}

export function effect<T = any>(
  fn: () => T,
  options?: ReactiveEffectOptions,
): ReactiveEffectRunner<T> {
  // 允许传入一个 runner：effect(() => runner()) 时取出它底层真正的 fn，避免
  // 包裹出“runner 套 runner”的双层依赖。
  if ((fn as ReactiveEffectRunner).effect instanceof ReactiveEffect) {
    fn = (fn as ReactiveEffectRunner).effect.fn
  }

  const e = new ReactiveEffect(fn)
  if (options) {
    // extend 把 scheduler/scope 外的选项（allowRecurse、onStop、onTrack…）拷到
    // effect 实例上，字段名与 ReactiveEffectOptions 一一对应。
    extend(e, options)
  }
  try {
    // effect() 是立即执行的：创建即跑第一轮，完成首次依赖收集。
    e.run()
  } catch (err) {
    // 首次执行失败就把刚建立的订阅拆掉，避免留下一个永远不会被清理的半成品。
    e.stop()
    throw err
  }
  const runner = e.run.bind(e) as ReactiveEffectRunner
  runner.effect = e
  return runner
}

/**
 * Stops the effect associated with the given runner.
 *
 * @param runner - Association with the effect to stop tracking.
 */
export function stop(runner: ReactiveEffectRunner): void {
  runner.effect.stop()
}

/**
 * @internal
 */
export let shouldTrack = true
// 用数组做栈，是为了支持任意深度的“暂停/恢复”嵌套。每一层只保存进入前的值，
// 退出时恢复，因此 pause 与 enable 可以交错调用而不互相污染。
const trackStack: boolean[] = []

/**
 * Temporarily pauses tracking.
 */
export function pauseTracking(): void {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

/**
 * Re-enables effect tracking (if it was paused).
 */
export function enableTracking(): void {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

/**
 * Resets the previous global effect tracking state.
 */
export function resetTracking(): void {
  // 栈空时回落到 true：容错，避免某次多调 reset 后永久关闭收集。
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

/**
 * Registers a cleanup function for the current active effect.
 * The cleanup function is called right before the next effect run, or when the
 * effect is stopped.
 *
 * Throws a warning if there is no current active effect. The warning can be
 * suppressed by passing `true` to the second argument.
 *
 * @param fn - the cleanup function to be registered
 * @param failSilently - if `true`, will not throw warning when called without
 * an active effect.
 */
export function onEffectCleanup(fn: () => void, failSilently = false): void {
  if (activeSub instanceof ReactiveEffect) {
    activeSub.cleanup = fn
  } else if (__DEV__ && !failSilently) {
    warn(
      `onEffectCleanup() was called when there was no active effect` +
        ` to associate with.`,
    )
  }
}

function cleanupEffect(e: ReactiveEffect) {
  // cleanup 只允许存在一个（覆盖式），与 watch 里可注册多个不同：onEffectCleanup
  // 面向 effect 作者做资源释放，watch 的 cleanup 列表见 watch.ts。
  const { cleanup } = e
  e.cleanup = undefined
  if (cleanup) {
    // run cleanup without active effect
    // 执行 cleanup 时临时清空 activeSub：cleanup 里读到的属性不应该被算作
    // effect 的依赖，否则可能形成“清理函数自己续命”的怪圈。
    const prevSub = activeSub
    activeSub = undefined
    try {
      cleanup()
    } finally {
      activeSub = prevSub
    }
  }
}
