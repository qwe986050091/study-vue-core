// ============================================================================
// scheduler.ts：更新队列（reactivity 的副作用如何落到渲染上）
// ============================================================================
// 响应式系统只负责“通知”：Dep.notify → ReactiveEffect.trigger → scheduler()。
// 组件渲染 effect 的 scheduler 是 `() => queueJob(job)`（renderer.ts:1654），
// 于是更新进入本文件的两条队列：
//   queue            主队列，按 job.id（= 组件 uid）升序执行 → 父先于子；
//   pendingPostFlushCbs  后置队列，mounted/updated 等钩子与 flush:'post' 的 watch。
//
// 一次 flush 的完整顺序：
//   flushJobs → 依次执行主队列（执行前可能插入新的更小 id 的 job）
//   → 主队列清空 → flushPostFlushCbs → 若两队列又非空则递归 flushJobs
// 整个过程包在一个微任务里（queueFlush 用 resolvedPromise.then），这就是
// nextTick / await nextTick() 能等到“DOM 已更新”的原因。
//
// 为什么需要队列而不是直接跑 effect：同一个 tick 内多个属性变化会多次触发同一
// 组件，队列用 QUEUED 标志去重；按 id 排序还顺带解决“父更新时卸载子组件，子的
// job 应跳过”的问题。
// ============================================================================

import { ErrorCodes, callWithErrorHandling, handleError } from './errorHandling'
import { NOOP, isArray } from '@vue/shared'
import { type ComponentInternalInstance, getComponentName } from './component'

export enum SchedulerJobFlags {
  QUEUED = 1 << 0,
  PRE = 1 << 1,
  /**
   * Indicates whether the effect is allowed to recursively trigger itself
   * when managed by the scheduler.
   *
   * By default, a job cannot trigger itself because some built-in method calls,
   * e.g. Array.prototype.push actually performs reads as well (#1740) which
   * can lead to confusing infinite loops.
   * The allowed cases are component update functions and watch callbacks.
   * Component update functions may update child component props, which in turn
   * trigger flush: "pre" watch callbacks that mutates state that the parent
   * relies on (#1801). Watch callbacks doesn't track its dependencies so if it
   * triggers itself again, it's likely intentional and it is the user's
   * responsibility to perform recursive state mutation that eventually
   * stabilizes (#1727).
   */
  ALLOW_RECURSE = 1 << 2,
  DISPOSED = 1 << 3,
  /**
   * A post job buffered by a suspense boundary is queued, not dropped, when
   * the pending branch is discarded.
   */
  REQUEUE_ON_SUSPENSE_DISCARD = 1 << 4,
  /**
   * A post job buffered by a suspense boundary is queued as soon as that
   * boundary resolves.
   */
  FLUSH_ON_SUSPENSE_RESOLVE = 1 << 5,
}

export interface SchedulerJob extends Function {
  id?: number
  /**
   * flags can technically be undefined, but it can still be used in bitwise
   * operations just like 0.
   */
  flags?: SchedulerJobFlags
  /**
   * Attached by renderer.ts when setting up a component's render effect
   * Used to obtain component information when reporting max recursive updates.
   * Also set on watcher jobs: null marks a watcher without an owner component.
   */
  i?: ComponentInternalInstance | null
}

export type SchedulerJobs = SchedulerJob | SchedulerJob[]

const queue: SchedulerJob[] = []
// 主队列的当前执行下标。-1 表示没在 flush；flushPreFlushCbs 会从 +1 开始扫描。
let flushIndex = -1

// pendingPostFlushCbs 是“待进入后置阶段”的队列；activePostFlushCbs 是正在执行
// 的快照。两者分开是为了支持执行期间新入队的 post cb 与嵌套 flush。
const pendingPostFlushCbs: SchedulerJob[] = []
let activePostFlushCbs: SchedulerJob[] | null = null
let postFlushIndex = 0

// 一个已 resolve 的 Promise：queueFlush 用它把 flushJobs 推到微任务。
const resolvedPromise = /*@__PURE__*/ Promise.resolve() as Promise<any>
// 非 null 表示“本 tick 已安排过 flush/正在 flush”，nextTick 也复用它。
let currentFlushPromise: Promise<void> | null = null

const RECURSION_LIMIT = 100
type CountMap = Map<SchedulerJob, number>

export function nextTick(): Promise<void>
export function nextTick<T, R>(
  this: T,
  fn: (this: T) => R | Promise<R>,
): Promise<R>
export function nextTick<T, R>(
  this: T,
  fn?: (this: T) => R | Promise<R>,
): Promise<void | R> {
  // 有正在进行的 flush 就等它结束，否则等一个已 resolve 的微任务。
  // 因此 `await nextTick()` 一定晚于本次 flush 的所有 DOM 变更。
  const p = currentFlushPromise || resolvedPromise
  return fn ? p.then(this ? fn.bind(this) : fn) : p
}

// Use binary-search to find a suitable position in the queue. The queue needs
// to be sorted in increasing order of the job ids. This ensures that:
// 1. Components are updated from parent to child. As the parent is always
//    created before the child it will always have a smaller id.
// 2. If a component is unmounted during a parent component's update, its update
//    can be skipped.
// A pre watcher will have the same id as its component's update job. The
// watcher should be inserted immediately before the update job. This allows
// watchers to be skipped if the component is unmounted by the parent update.
// 中文：按 id 升序维护队列，id 就是组件 uid（父一定小于子）。同 id 时 pre
// watcher 排在组件更新之前——这样父组件更新里若卸载了子组件，子的 pre job
// 与更新 job 都还在队列后面，可以按 DISPOSED 跳过。
function findInsertionIndex(id: number) {
  let start = flushIndex + 1
  let end = queue.length

  while (start < end) {
    const middle = (start + end) >>> 1
    const middleJob = queue[middle]
    const middleJobId = getId(middleJob)
    if (
      middleJobId < id ||
      (middleJobId === id && middleJob.flags! & SchedulerJobFlags.PRE)
    ) {
      start = middle + 1
    } else {
      end = middle
    }
  }

  return start
}

export function queueJob(job: SchedulerJob): void {
  // QUEUED 去重：同一 job 只能存在一份。注意执行时不清这个标志，所以在 job
  // 内部再触发自己时仍能正确判重（ALLOW_RECURSE 的 job 例外，见 flushJobs）。
  if (!(job.flags! & SchedulerJobFlags.QUEUED)) {
    const jobId = getId(job)
    const lastJob = queue[queue.length - 1]
    // 快路径：队列空，或新 job 的 id 不小于队尾，直接 push。
    // pre job 不走快路径，因为它要插到同 id 的更新 job 前面。
    if (
      !lastJob ||
      // fast path when the job id is larger than the tail
      (!(job.flags! & SchedulerJobFlags.PRE) && jobId >= getId(lastJob))
    ) {
      queue.push(job)
    } else {
      queue.splice(findInsertionIndex(jobId), 0, job)
    }

    job.flags! |= SchedulerJobFlags.QUEUED

    queueFlush()
  }
}

function queueFlush() {
  // 只在没有进行中的 flush 时安排一次微任务；同一 tick 的多次 queueJob 共享它。
  if (!currentFlushPromise) {
    currentFlushPromise = resolvedPromise.then(flushJobs)
  }
}

export function queuePostFlushCb(cb: SchedulerJobs): void {
  if (!isArray(cb)) {
    // 正在跑 post 阶段时（activePostFlushCbs 非空）且 cb.id === -1：说明这是
    // 执行期间新插入的无主任务，直接插到当前下标之后，保证本轮就能跑到。
    if (activePostFlushCbs && cb.id === -1) {
      activePostFlushCbs.splice(postFlushIndex + 1, 0, cb)
    } else if (!(cb.flags! & SchedulerJobFlags.QUEUED)) {
      pendingPostFlushCbs.push(cb)
      cb.flags! |= SchedulerJobFlags.QUEUED
    }
  } else {
    // if cb is an array, it is a component lifecycle hook which can only be
    // triggered by a job, which is already deduped in the main queue, so
    // we can skip duplicate check here to improve perf.
    // use a loop instead of `push(...cb)`: the array can be arbitrarily large
    // (e.g. effects buffered by a suspense boundary) and spreading it would
    // overflow the call stack (#15142)
    // 数组形态是组件生命周期钩子（mounted/updated 等），来源 job 已在主队列
    // 去重，这里不再判重；用循环而不是 push(...cb) 防止大数组爆栈。
    for (let i = 0; i < cb.length; i++) {
      pendingPostFlushCbs.push(cb[i])
    }
  }
  queueFlush()
}

export function flushPreFlushCbs(
  instance?: ComponentInternalInstance,
  // root mount: only flush the jobs of the components it created
  // 根挂载时只刷新“本次挂载创建的组件”的 pre job，避免误跑其他组件遗留的 job。
  minUid?: number,
  seen?: CountMap,
  // skip the current job
  i: number = flushIndex + 1,
): void {
  if (__DEV__) {
    seen = seen || new Map()
  }
  for (; i < queue.length; i++) {
    const cb = queue[i]
    if (cb && cb.flags! & SchedulerJobFlags.PRE) {
      // 过滤：指定了 instance 就只跑它的；指定了 minUid 就只跑 uid 达标的。
      if (
        (instance && cb.id !== instance.uid) ||
        (minUid !== undefined && !(cb.id! >= minUid))
      ) {
        continue
      }
      if (__DEV__ && checkRecursiveUpdates(seen!, cb)) {
        continue
      }
      // 先从队列摘掉再执行：执行过程中可能 push 新的更小 id 的 job，所以执行
      // 完要把下标回退，重新扫描这一段。
      queue.splice(i, 1)
      // the job may queue a job with a smaller id ahead of this index. A job
      // of the same instance can't, so no rescan is needed for that filter.
      i = instance ? i - 1 : flushIndex
      // ALLOW_RECURSE 的 job 在执行前清 QUEUED，允许它执行中重新入队自己。
      if (cb.flags! & SchedulerJobFlags.ALLOW_RECURSE) {
        cb.flags! &= ~SchedulerJobFlags.QUEUED
      }
      cb()
      if (!(cb.flags! & SchedulerJobFlags.ALLOW_RECURSE)) {
        cb.flags! &= ~SchedulerJobFlags.QUEUED
      }
    }
  }
}

export function flushPostFlushCbs(
  seen?: CountMap,
  // root mount: cbs queued before it, left in the queue
  skip?: Set<SchedulerJob>,
  // root mount: watchers are kept or flushed by owner instead, so that those
  // of other components (or without one) are left too
  minUid = 0,
): void {
  if (pendingPostFlushCbs.length) {
    let cbs = pendingPostFlushCbs
    let kept = 0
    // 根挂载路径（传了 skip / minUid）需要把“不属于本次挂载”的 post cb 留在
    // 原队列里：原地压缩数组，前半段是保留项，后半段是待执行项。
    if (skip) {
      cbs = []
      for (let i = 0; i < pendingPostFlushCbs.length; i++) {
        const cb = pendingPostFlushCbs[i]
        if (cb.i !== undefined ? !cb.i || cb.i.uid < minUid : skip.has(cb)) {
          pendingPostFlushCbs[kept++] = cb
        } else {
          cbs.push(cb)
        }
      }
    }
    // 去重 + 按 id 稳定排序：post 阶段同样要保证父先于子。
    const deduped = [...new Set(cbs)].sort((a, b) => getId(a) - getId(b))
    pendingPostFlushCbs.length = kept

    // #1947 already has active queue, nested flushPostFlushCbs call
    // 已经在 post 阶段里又被调用：把新任务追加到 active 队列，本轮循环会接着跑。
    if (activePostFlushCbs) {
      for (let i = 0; i < deduped.length; i++) {
        activePostFlushCbs.push(deduped[i])
      }
      return
    }

    activePostFlushCbs = deduped
    if (__DEV__) {
      seen = seen || new Map()
    }

    for (
      postFlushIndex = 0;
      postFlushIndex < activePostFlushCbs.length;
      postFlushIndex++
    ) {
      const cb = activePostFlushCbs[postFlushIndex]
      if (__DEV__ && checkRecursiveUpdates(seen!, cb)) {
        continue
      }
      // 与主队列相同：ALLOW_RECURSE 的任务在执行前清 QUEUED，允许自我重入。
      if (cb.flags! & SchedulerJobFlags.ALLOW_RECURSE) {
        cb.flags! &= ~SchedulerJobFlags.QUEUED
      }
      // DISPOSED：排队后组件被卸载，跳过回调（卸载清理已经在别处做过）。
      if (!(cb.flags! & SchedulerJobFlags.DISPOSED)) cb()
      cb.flags! &= ~SchedulerJobFlags.QUEUED
    }
    activePostFlushCbs = null
    postFlushIndex = 0
  }
}

let isFlushing = false

/**
 * Run a root render, then flush the jobs it is responsible for. A mount or
 * unmount (`minUid` given) only flushes the jobs of the components it created
 * and the post cbs it queued, so pre watchers triggered in setup run before
 * mounted (#5721) while the jobs of other components stay in the queue and
 * keep their order (#6728). A root update keeps flushing all pending pre jobs
 * and post cbs, as the jobs of the components it re-renders may predate it.
 */
export function flushOnAppMount(fn: () => void, minUid?: number): void {
  // 已经在 flush 里（例如某个 job 里同步 mount 子应用）：不能再嵌套跑队列，
  // 直接执行 fn，外层 flush 会自然处理新入队的 job。
  if (isFlushing) {
    fn()
    return
  }
  // 快照挂载前的 post 队列：这些是“别人”的安排，本次挂载不负责跑。
  const queued = minUid === undefined ? undefined : new Set(pendingPostFlushCbs)
  fn()
  isFlushing = true
  try {
    // 只跑 uid >= minUid 的 pre job，以及本次挂载新产生的 post cb：
    // 这样 setup 里的 watch({immediate}) 会先于 mounted 执行（#5721），
    // 而其他组件已排队的 job 保持原顺序、不被本次挂载插队（#6728）。
    flushPreFlushCbs(undefined, minUid)
    flushPostFlushCbs(undefined, queued, minUid)
  } finally {
    isFlushing = false
  }
}

const getId = (job: SchedulerJob): number =>
  job.id == null ? (job.flags! & SchedulerJobFlags.PRE ? -1 : Infinity) : job.id

function flushJobs(seen?: CountMap) {
  if (__DEV__) {
    seen = seen || new Map()
  }

  // conditional usage of checkRecursiveUpdate must be determined out of
  // try ... catch block since Rollup by default de-optimizes treeshaking
  // inside try-catch. This can leave all warning code unshaked. Although
  // they would get eventually shaken by a minifier like terser, some minifiers
  // would fail to do that (e.g. https://github.com/evanw/esbuild/issues/1610)
  // 中文：把 DEV 判断提到 try 外面，生产构建才能把整个递归检测裁掉。
  const check = __DEV__
    ? (job: SchedulerJob) => checkRecursiveUpdates(seen!, job)
    : NOOP

  try {
    // 循环条件每轮重读 queue.length：job 执行中新增的 job 会插在当前位置之后，
    // 因而同一轮 flush 内就能被扫到；id 更小的（父组件）也不例外。
    for (flushIndex = 0; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex]
      if (job && !(job.flags! & SchedulerJobFlags.DISPOSED)) {
        if (__DEV__ && check(job)) {
          continue
        }
        // ALLOW_RECURSE 的任务先清 QUEUED：这样它在执行中触发自己时能重新入队，
        // 而不是被去重逻辑吃掉。
        if (job.flags! & SchedulerJobFlags.ALLOW_RECURSE) {
          job.flags! &= ~SchedulerJobFlags.QUEUED
        }
        // 单个 job 抛错不会打断 flush：错误交给组件 errorHandler 处理后继续。
        callWithErrorHandling(
          job,
          job.i,
          job.i ? ErrorCodes.COMPONENT_UPDATE : ErrorCodes.SCHEDULER,
        )
        if (!(job.flags! & SchedulerJobFlags.ALLOW_RECURSE)) {
          job.flags! &= ~SchedulerJobFlags.QUEUED
        }
      }
    }
  } finally {
    // If there was an error we still need to clear the QUEUED flags
    // 异常路径：没执行到的 job 也要清 QUEUED，否则它们以后永远无法重新入队。
    for (; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex]
      if (job) {
        job.flags! &= ~SchedulerJobFlags.QUEUED
      }
    }

    flushIndex = -1
    queue.length = 0

    // 主队列清空后才跑 post：此时 DOM 已完成更新。
    flushPostFlushCbs(seen)

    currentFlushPromise = null
    // If new jobs have been added to either queue, keep flushing
    // post 回调里可能又触发了主队列，必须继续 flush 直到两条队列都空。
    if (queue.length || pendingPostFlushCbs.length) {
      flushJobs(seen)
    }
  }
}

function checkRecursiveUpdates(seen: CountMap, fn: SchedulerJob) {
  // 计数语义：第一次看到 count=0 → set 1；第 N 次时 count=N-1，超过 100 报错。
  const count = seen.get(fn) || 0
  if (count > RECURSION_LIMIT) {
    const instance = fn.i
    const componentName = instance && getComponentName(instance.type)
    handleError(
      `Maximum recursive updates exceeded${
        componentName ? ` in component <${componentName}>` : ``
      }. ` +
        `This means you have a reactive effect that is mutating its own ` +
        `dependencies and thus recursively triggering itself. Possible sources ` +
        `include component template, render function, updated hook or ` +
        `watcher source function.`,
      null,
      ErrorCodes.APP_ERROR_HANDLER,
    )
    return true
  }
  seen.set(fn, count + 1)
  return false
}
