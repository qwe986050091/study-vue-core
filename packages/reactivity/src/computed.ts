// ============================================================================
// computed.ts：惰性求值 + 脏标记
// ============================================================================
// computed 同时扮演两个角色：
//   1. Subscriber —— 它订阅 getter 里读到的属性（deps/depsTail/flags）；
//   2. 依赖源    —— 它自己持有一个 Dep（dep），下游读 .value 时订阅的是它。
// 所以它既是“边”的一端，也是另一个“点”。
//
// 惰性链条（读 .value 时）：
//   Dep.track() 记下“下游依赖 computed”
//   → refreshComputed() 判断要不要重算
//   → 重算时 activeSub 换成 computed 自己，getter 里的读记到它的 deps 上
//   → 值真变了才 dep.version++，从而让下游 isDirty 成立
// 触发链条（上游变化时）：
//   Dep.notify() 调 computed.notify() → 只置 DIRTY + 把自己排进 computed 批
//   → endBatch 只清 NOTIFIED 不执行
//   → 真正的重算推迟到下一次 .value 读取
//
// 这就是“computed 没人读就不会算”的全部机制；DIRTY 是唯一的“可能过期”标记，
// 真正的过期判断在 refreshComputed 里用版本号比较完成。
// ============================================================================

import { isFunction } from '@vue/shared'
import {
  type DebuggerEvent,
  type DebuggerOptions,
  EffectFlags,
  type Subscriber,
  activeSub,
  batch,
  refreshComputed,
} from './effect'
import type { Ref } from './ref'
import { warn } from './warning'
import { Dep, type Link, globalVersion } from './dep'
import { ReactiveFlags, TrackOpTypes } from './constants'

declare const ComputedRefSymbol: unique symbol
declare const WritableComputedRefSymbol: unique symbol

interface BaseComputedRef<T, S = T> extends Ref<T, S> {
  [ComputedRefSymbol]: true
  /**
   * @deprecated computed no longer uses effect
   */
  effect: ComputedRefImpl
}

export interface ComputedRef<T = any> extends BaseComputedRef<T> {
  readonly value: T
}

export interface WritableComputedRef<T, S = T> extends BaseComputedRef<T, S> {
  [WritableComputedRefSymbol]: true
}

export type ComputedGetter<T> = (oldValue?: T) => T
export type ComputedSetter<T> = (newValue: T) => void

export interface WritableComputedOptions<T, S = T> {
  get: ComputedGetter<T>
  set: ComputedSetter<S>
}

/**
 * @private exported by @vue/reactivity for Vue core use, but not exported from
 * the main vue package
 */
export class ComputedRefImpl<T = any> implements Subscriber {
  /**
   * @internal
   */
  _value: any = undefined
  /**
   * @internal
   */
  // 对外暴露的依赖源。下游 effect 读 .value 时订阅的就是它，而不是 getter 里
  // 那些原始属性——这正是 computed 能把“多个上游变化”折叠成“一次下游执行”的原因。
  readonly dep: Dep = new Dep(this)
  /**
   * @internal
   */
  readonly __v_isRef = true
  // TODO isolatedDeclarations ReactiveFlags.IS_REF
  /**
   * @internal
   */
  readonly __v_isReadonly: boolean
  // TODO isolatedDeclarations ReactiveFlags.IS_READONLY
  // A computed is also a subscriber that tracks other deps
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
  flags: EffectFlags = EffectFlags.DIRTY
  /**
   * @internal
   */
  // 初值 globalVersion - 1：保证第一次读一定不会命中“世界没变”的快路径。
  globalVersion: number = globalVersion - 1
  /**
   * @internal
   */
  // SSR 下没有渲染 effect 作为下游，computed 不会留下 deps，所以 refreshComputed
  // 不能依赖 isDirty，只能靠 globalVersion 做缓存（详见 effect.ts）。
  isSSR: boolean
  /**
   * @internal
   */
  next?: Subscriber = undefined

  // for backwards compat
  effect: this = this
  // dev only
  onTrack?: (event: DebuggerEvent) => void
  // dev only
  onTrigger?: (event: DebuggerEvent) => void

  /**
   * Dev only
   * @internal
   */
  _warnRecursive?: boolean

  constructor(
    public fn: ComputedGetter<T>,
    private readonly setter: ComputedSetter<T> | undefined,
    isSSR: boolean,
  ) {
    this[ReactiveFlags.IS_READONLY] = !setter
    this.isSSR = isSSR
  }

  /**
   * @internal
   */
  notify(): true | void {
    // 只标脏 + 入队，不求值：
    //   DIRTY    —— 下次读 .value 时 refreshComputed 会真正检查；
    //   NOTIFIED —— 同一批次内避免重复入队；
    //   activeSub !== this —— 防止 computed 在自己的 getter 里写自己造成递归。
    this.flags |= EffectFlags.DIRTY
    if (
      !(this.flags & EffectFlags.NOTIFIED) &&
      // avoid infinite self recursion
      activeSub !== this
    ) {
      // 返回 true 告诉 Dep.notify()：“我是 computed，请顺手通知我的下游”。
      batch(this, true)
      return true
    } else if (__DEV__) {
      // TODO warn
    }
  }

  get value(): T {
    // 先 track：下游订阅的是 computed 自己的 dep，而不是它内部的属性。
    // 顺序很关键——必须在 refreshComputed 之前 track，否则重算过程中 activeSub
    // 已切换成 computed，下游依赖会记错对象。
    const link = __DEV__
      ? this.dep.track({
          target: this,
          type: TrackOpTypes.GET,
          key: 'value',
        })
      : this.dep.track()
    refreshComputed(this)
    // sync version after evaluation
    // 求值可能让 dep.version 自增；把刚建的 link 版本对齐到最新，避免它自己
    // 立刻被判成脏（否则读一次就会触发一次多余的重算）。
    if (link) {
      link.version = this.dep.version
    }
    return this._value
  }

  set value(newValue) {
    if (this.setter) {
      this.setter(newValue)
    } else if (__DEV__) {
      warn('Write operation failed: computed value is readonly')
    }
  }
}

/**
 * Takes a getter function and returns a readonly reactive ref object for the
 * returned value from the getter. It can also take an object with get and set
 * functions to create a writable ref object.
 *
 * @example
 * ```js
 * // Creating a readonly computed ref:
 * const count = ref(1)
 * const plusOne = computed(() => count.value + 1)
 *
 * console.log(plusOne.value) // 2
 * plusOne.value++ // error
 * ```
 *
 * ```js
 * // Creating a writable computed ref:
 * const count = ref(1)
 * const plusOne = computed({
 *   get: () => count.value + 1,
 *   set: (val) => {
 *     count.value = val - 1
 *   }
 * })
 *
 * plusOne.value = 1
 * console.log(count.value) // 0
 * ```
 *
 * @param getter - Function that produces the next value.
 * @param debugOptions - For debugging. See {@link https://vuejs.org/guide/extras/reactivity-in-depth.html#computed-debugging}.
 * @see {@link https://vuejs.org/api/reactivity-core.html#computed}
 */
export function computed<T>(
  getter: ComputedGetter<T>,
  debugOptions?: DebuggerOptions,
): ComputedRef<T>
export function computed<T, S = T>(
  options: WritableComputedOptions<T, S>,
  debugOptions?: DebuggerOptions,
): WritableComputedRef<T, S>
/*@__NO_SIDE_EFFECTS__*/
export function computed<T>(
  getterOrOptions: ComputedGetter<T> | WritableComputedOptions<T>,
  debugOptions?: DebuggerOptions,
  isSSR = false,
) {
  let getter: ComputedGetter<T>
  let setter: ComputedSetter<T> | undefined

  if (isFunction(getterOrOptions)) {
    getter = getterOrOptions
  } else {
    getter = getterOrOptions.get
    setter = getterOrOptions.set
  }

  const cRef = new ComputedRefImpl(getter, setter, isSSR)

  if (__DEV__ && debugOptions && !isSSR) {
    cRef.onTrack = debugOptions.onTrack
    cRef.onTrigger = debugOptions.onTrigger
  }

  return cRef as any
}
