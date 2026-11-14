// ============================================================================
// watch.ts：把 effect 包装成“观察者”
// ============================================================================
// watch 与 effect 的关系：
//   watch 内部一定创建一个 ReactiveEffect；区别只在
//   1. 传入 scheduler —— 依赖变化时不立即跑，而是把 job 交给调度器；公开的
//      vue 包里默认 flush: 'pre'，该 scheduler 由 runtime-core/apiWatch.ts:210
//      注入（queueJob）。本文件不传 scheduler 时是同步执行 job。
//   2. 多存了一份 oldValue —— 只有新旧值不同（或 deep/forceTrigger）才回调；
//   3. cleanup —— 每次回调前先跑上一次注册的清理函数。
//
// watchEffect 是 cb === null 的特例：没有新旧值比较，依赖一变就重跑整个函数。
//
// 阅读顺序建议：先看 source 归一化（getter 怎么来的），再看 job（何时执行），
// 最后看 initial run（首次是同步跑还是进队列）。traverse 是 deep 的实现。
// ============================================================================

import {
  EMPTY_OBJ,
  NOOP,
  hasChanged,
  isArray,
  isFunction,
  isMap,
  isObject,
  isPlainObject,
  isSet,
  remove,
} from '@vue/shared'
import { warn } from './warning'
import type { ComputedRef } from './computed'
import { ReactiveFlags } from './constants'
import {
  type DebuggerOptions,
  EffectFlags,
  type EffectScheduler,
  ReactiveEffect,
  pauseTracking,
  resetTracking,
} from './effect'
import { isReactive, isShallow } from './reactive'
import { type Ref, isRef } from './ref'
import { getCurrentScope } from './effectScope'

// These errors were transferred from `packages/runtime-core/src/errorHandling.ts`
// to @vue/reactivity to allow co-location with the moved base watch logic, hence
// it is essential to keep these values unchanged.
export enum WatchErrorCodes {
  WATCH_GETTER = 2,
  WATCH_CALLBACK,
  WATCH_CLEANUP,
}

export type WatchEffect = (onCleanup: OnCleanup) => void

export type WatchSource<T = any> = Ref<T, any> | ComputedRef<T> | (() => T)

export type WatchCallback<V = any, OV = any> = (
  value: V,
  oldValue: OV,
  onCleanup: OnCleanup,
) => any

export type OnCleanup = (cleanupFn: () => void) => void

export interface WatchOptions<Immediate = boolean> extends DebuggerOptions {
  immediate?: Immediate
  deep?: boolean | number
  once?: boolean
  scheduler?: WatchScheduler
  onWarn?: (msg: string, ...args: any[]) => void
  /**
   * @internal
   */
  augmentJob?: (job: (...args: any[]) => void) => void
  /**
   * @internal
   */
  call?: (
    fn: Function | Function[],
    type: WatchErrorCodes,
    args?: unknown[],
  ) => void
}

export type WatchStopHandle = () => void

export interface WatchHandle extends WatchStopHandle {
  pause: () => void
  resume: () => void
  stop: () => void
}

// initial value for watchers to trigger on undefined initial values
// 哨兵对象而不是 undefined：用户回调的第一个参数可能是 undefined（源值就是
// undefined），需要区分“还没跑过”和“跑过但值是 undefined”。
const INITIAL_WATCHER_VALUE = {}

export type WatchScheduler = (job: () => void, isFirstRun: boolean) => void

// watch 的 cleanup 允许多个（数组），与 ReactiveEffect.cleanup 的单值不同；
// 用 WeakMap 挂在 effect 上，effect 被回收时清理列表一起消失。
const cleanupMap: WeakMap<ReactiveEffect, (() => void)[]> = new WeakMap()
// 当前正在执行的 watcher。onWatcherCleanup 在回调里被调用时靠它找到归属。
let activeWatcher: ReactiveEffect | undefined = undefined

/**
 * Returns the current active effect if there is one.
 */
export function getCurrentWatcher(): ReactiveEffect<any> | undefined {
  return activeWatcher
}

/**
 * Registers a cleanup callback on the current active effect. This
 * registered cleanup callback will be invoked right before the
 * associated effect re-runs.
 *
 * @param cleanupFn - The callback function to attach to the effect's cleanup.
 * @param failSilently - if `true`, will not throw warning when called without
 * an active effect.
 * @param owner - The effect that this cleanup function should be attached to.
 * By default, the current active effect.
 */
export function onWatcherCleanup(
  cleanupFn: () => void,
  failSilently = false,
  owner: ReactiveEffect | undefined = activeWatcher,
): void {
  // 三个来源：显式传 owner；回调执行期间的 activeWatcher；都没有则忽略/警告。
  // 注册的清理函数在下一次 job 执行前（watchEffect 的 getter 开头）或 effect
  // 被 stop 时（effect.onStop）统一执行。
  if (owner) {
    let cleanups = cleanupMap.get(owner)
    if (!cleanups) cleanupMap.set(owner, (cleanups = []))
    cleanups.push(cleanupFn)
  } else if (__DEV__ && !failSilently) {
    warn(
      `onWatcherCleanup() was called when there was no active watcher` +
        ` to associate with.`,
    )
  }
}

export function watch(
  source: WatchSource | WatchSource[] | WatchEffect | object,
  cb?: WatchCallback | null,
  options: WatchOptions = EMPTY_OBJ,
): WatchHandle {
  const { immediate, deep, once, scheduler, augmentJob, call } = options

  const warnInvalidSource = (s: unknown) => {
    ;(options.onWarn || warn)(
      `Invalid watch source: `,
      s,
      `A watch source can only be a getter/effect function, a ref, ` +
        `a reactive object, or an array of these types.`,
    )
  }

  const reactiveGetter = (source: object) => {
    // traverse will happen in wrapped getter below
    // deep: true 时这里不遍历，留给下面 `cb && deep` 的包装（能带上深度）。
    if (deep) return source
    // for `deep: false | 0` or shallow reactive, only traverse root-level properties
    // deep: false/0 或浅代理：只读一层。注意 deep 未传（undefined）时走最后的
    // 全量 traverse——watch(reactiveObj, cb) 默认是深观察。
    if (isShallow(source) || deep === false || deep === 0)
      return traverse(source, 1)
    // for `deep: undefined` on a reactive object, deeply traverse all properties
    return traverse(source)
  }

  let effect: ReactiveEffect
  let getter: () => any
  let cleanup: (() => void) | undefined
  let boundCleanup: typeof onWatcherCleanup
  // forceTrigger：即使新旧值 === 也回调。reactive 对象恒为 true（同一代理的
  // 引用不变，只能靠这个强制）；浅 ref 也 true（内部值变了但引用没变）。
  let forceTrigger = false
  let isMultiSource = false

  // 源归一化：无论用户传什么，最终都要变成一个无参 getter。
  if (isRef(source)) {
    getter = () => source.value
    forceTrigger = isShallow(source)
  } else if (isReactive(source)) {
    getter = () => reactiveGetter(source)
    forceTrigger = true
  } else if (isArray(source)) {
    isMultiSource = true
    // 多源里只要有 reactive/浅源，就必须 forceTrigger（数组每项分别比较）。
    forceTrigger = source.some(s => isReactive(s) || isShallow(s))
    getter = () =>
      source.map(s => {
        if (isRef(s)) {
          return s.value
        } else if (isReactive(s)) {
          return reactiveGetter(s)
        } else if (isFunction(s)) {
          // 多源里的 getter 也要收集依赖；call 是 runtime-core 注入的错误处理。
          return call ? call(s, WatchErrorCodes.WATCH_GETTER) : s()
        } else {
          __DEV__ && warnInvalidSource(s)
        }
      })
  } else if (isFunction(source)) {
    if (cb) {
      // getter with cb
      // watch(getter, cb)：getter 只负责收集依赖并返回值。
      getter = call
        ? () => call(source, WatchErrorCodes.WATCH_GETTER)
        : (source as () => any)
    } else {
      // no cb -> simple effect
      // watchEffect：每次重跑前先执行上一次的 cleanup，并在运行期间把
      // activeWatcher 指向本 effect，使 onWatcherCleanup 能找到归属。
      getter = () => {
        if (cleanup) {
          pauseTracking()
          try {
            cleanup()
          } finally {
            resetTracking()
          }
        }
        const currentEffect = activeWatcher
        activeWatcher = effect
        try {
          return call
            ? call(source, WatchErrorCodes.WATCH_CALLBACK, [boundCleanup])
            : source(boundCleanup)
        } finally {
          activeWatcher = currentEffect
        }
      }
    }
  } else {
    // 非法源：给一个空 getter，DEV 下警告；不会因此中断组件渲染。
    getter = NOOP
    __DEV__ && warnInvalidSource(source)
  }

  if (cb && deep) {
    // deep 最终落成一次全量 traverse：读取所有嵌套属性，从而把它们都记进
    // 这个 effect 的依赖。deep 为数字时限制深度。
    const baseGetter = getter
    const depth = deep === true ? Infinity : deep
    getter = () => traverse(baseGetter(), depth)
  }

  // 归属 scope：组件卸载/scope.stop() 时能一起停掉 watch。
  const scope = getCurrentScope()
  const watchHandle: WatchHandle = () => {
    effect.stop()
    if (scope && scope.active) {
      // stop 之后还要从 scope.effects 里摘掉，否则 scope 数组只增不减。
      remove(scope.effects, effect)
    }
  }

  if (once && cb) {
    // once 只在回调后停一次：把用户 cb 包一层，finally 里调 watchHandle()。
    // 注意只对带 cb 的 watch 生效；watchEffect 没有“执行一次”的语义。
    const _cb = cb
    cb = (...args) => {
      try {
        return _cb(...args)
      } finally {
        watchHandle()
      }
    }
  }

  let oldValue: any = isMultiSource
    ? new Array((source as []).length).fill(INITIAL_WATCHER_VALUE)
    : INITIAL_WATCHER_VALUE

  const job = (immediateFirstRun?: boolean) => {
    // 两个提前退出：
    //   - effect 已 stop（watchHandle 调过）；
    //   - 没有新变化（dirty 为 false）。第二次触发时依赖可能已被上一轮重跑
    //     更新过版本，不脏就不该回调。首次（immediate）跳过脏检查。
    if (
      !(effect.flags & EffectFlags.ACTIVE) ||
      (!effect.dirty && !immediateFirstRun)
    ) {
      return
    }
    if (cb) {
      // watch(source, cb)
      // 先跑 getter 求新值（同时重建依赖）；run() 内部会做依赖淘汰。
      const newValue = effect.run()
      if (
        immediateFirstRun ||
        deep ||
        forceTrigger ||
        (isMultiSource
          ? (newValue as any[]).some((v, i) => hasChanged(v, oldValue[i]))
          : hasChanged(newValue, oldValue))
      ) {
        // 回调期间暂停依赖收集：cb 里读到的响应式数据不应算作本 watch 的依赖。
        const currentWatcher = activeWatcher
        pauseTracking()
        try {
          // cleanup before running cb again
          // 先清理上一轮副作用，再调用新回调。
          if (cleanup) {
            cleanup()
          }
          activeWatcher = effect
          const args = [
            newValue,
            // pass undefined as the old value when it's changed for the first time
            // 首次回调（immediate 或第一次触发）oldValue 传 undefined；多源且
            // 尚未初始化时传空数组。
            oldValue === INITIAL_WATCHER_VALUE
              ? undefined
              : isMultiSource && oldValue[0] === INITIAL_WATCHER_VALUE
                ? []
                : oldValue,
            boundCleanup,
          ]
          oldValue = newValue
          call
            ? call(cb!, WatchErrorCodes.WATCH_CALLBACK, args)
            : // @ts-expect-error
              cb!(...args)
        } finally {
          activeWatcher = currentWatcher
          resetTracking()
        }
      }
    } else {
      // watchEffect
      // 没有 cb：直接重跑整个副作用函数。
      effect.run()
    }
  }

  if (augmentJob) {
    // runtime-core 用它在 job 上挂 id / PRE / ALLOW_RECURSE 等调度器元数据。
    augmentJob(job)
  }

  effect = new ReactiveEffect(getter)

  // 有 scheduler 就用它包装 job；没有则直接把 job 当调度器——ReactiveEffect
  // 的 trigger() 会调用 this.scheduler()，于是同步执行 job。
  effect.scheduler = scheduler
    ? () => scheduler(job, false)
    : (job as EffectScheduler)

  // 绑定归属：回调里调用 onWatcherCleanup(fn) 等价于 onWatcherCleanup(fn,false,effect)。
  boundCleanup = fn => onWatcherCleanup(fn, false, effect)

  cleanup = effect.onStop = () => {
    // effect.stop() 时把所有登记过的 cleanup 一次性跑完并清空。
    // 注意这与“每次重跑前跑 cleanup”是两条不同路径：一条在 job 里，一条在这里。
    const cleanups = cleanupMap.get(effect)
    if (cleanups) {
      if (call) {
        call(cleanups, WatchErrorCodes.WATCH_CLEANUP)
      } else {
        for (const cleanup of cleanups) cleanup()
      }
      cleanupMap.delete(effect)
    }
  }

  if (__DEV__) {
    effect.onTrack = options.onTrack
    effect.onTrigger = options.onTrigger
  }

  // initial run
  // 三种首次行为：
  //   immediate + cb → 立即执行 job（会走一次完整回调）；
  //   普通 cb        → 只跑 getter 存 oldValue，不回调；
  //   watchEffect    → 直接 effect.run()；若带 scheduler，则把“首次”也交给
  //                    调度器（isFirstRun = true）。
  if (cb) {
    if (immediate) {
      job(true)
    } else {
      oldValue = effect.run()
    }
  } else if (scheduler) {
    scheduler(job.bind(null, true), true)
  } else {
    effect.run()
  }

  watchHandle.pause = effect.pause.bind(effect)
  watchHandle.resume = effect.resume.bind(effect)
  watchHandle.stop = watchHandle

  return watchHandle
}

export function traverse(
  value: unknown,
  depth: number = Infinity,
  seen?: Map<unknown, number>,
): unknown {
  // 深度遍历的本质是“把每个嵌套属性都读一遍”，从而让当前 activeSub 把所有
  // 属性的 Dep 都记成依赖。三个保护：
  //   depth <= 0      —— 到达指定深度；
  //   !isObject      —— 原始值/函数没有可读属性；
  //   markRaw 标记   —— 明确要求不被观察的子树直接跳过。
  if (depth <= 0 || !isObject(value) || (value as any)[ReactiveFlags.SKIP]) {
    return value
  }

  // seen 记录“某个对象在更深的剩余深度上已经遍历过”，用于打断循环引用，也避免
  // 同一对象被浅层遍历覆盖掉深层的需要（保留更大的剩余深度）。
  seen = seen || new Map()
  if ((seen.get(value) || 0) >= depth) {
    return value
  }
  seen.set(value, depth)
  depth--
  if (isRef(value)) {
    traverse(value.value, depth, seen)
  } else if (isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      traverse(value[i], depth, seen)
    }
  } else if (isSet(value) || isMap(value)) {
    // 只遍历值，不遍历键：与 Vue 的依赖模型一致（Map 的键变更另有 ITERATE 依赖）。
    value.forEach((v: any) => {
      traverse(v, depth, seen)
    })
  } else if (isPlainObject(value)) {
    for (const key in value) {
      traverse(value[key], depth, seen)
    }
    // for-in 不会枚举 Symbol 键，这里补上可枚举的 Symbol 属性。
    for (const key of Object.getOwnPropertySymbols(value)) {
      if (Object.prototype.propertyIsEnumerable.call(value, key)) {
        traverse(value[key as any], depth, seen)
      }
    }
  }
  return value
}
