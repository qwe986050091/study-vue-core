// ============================================================================
// ref.ts：单值容器
// ============================================================================
// ref 解决的是“原始值无法被 Proxy 拦截”的问题：Proxy 只能包对象，而 number /
// string 没有属性可拦。做法是造一个小对象，把值放在 .value 上，读写 .value 时
// 手动 track / trigger（一个 RefImpl 持有一个 Dep）。
//
// 几个容易混的点：
//   - _rawValue 与 _value 不是同一份：_rawValue 永远存原始值（用于 hasChanged
//     比较），_value 存“可能被 reactive 包过”的展示值；
//   - 对象 ref 的深响应不靠 RefImpl 递归，而靠 toReactive(value) 把对象包成
//     reactive 代理，之后读写走的是 baseHandlers；
//   - ObjectRefImpl（toRef）不持有 Dep，它的 dep 是从 targetMap 里反查出来的，
//     因此它的更新依赖源对象本身；
//   - customRef 把 Dep 的 track/trigger 直接交给用户，是唯一“手动挡”入口。
// ============================================================================

import {
  type IfAny,
  hasChanged,
  isArray,
  isFunction,
  isIntegerKey,
  isObject,
  isSymbol,
} from '@vue/shared'
import { Dep, getDepFromReactive } from './dep'
import {
  type Builtin,
  type ShallowReactiveBrand,
  type Target,
  isProxy,
  isReactive,
  isReadonly,
  isShallow,
  toRaw,
  toReactive,
} from './reactive'
import type { ComputedRef, WritableComputedRef } from './computed'
import { ReactiveFlags, TrackOpTypes, TriggerOpTypes } from './constants'
import { warn } from './warning'

declare const RefSymbol: unique symbol
export declare const RawSymbol: unique symbol

export interface Ref<T = any, S = T> {
  get value(): T
  set value(_: S)
  /**
   * Type differentiator only.
   * We need this to be in public d.ts but don't want it to show up in IDE
   * autocomplete, so we use a private Symbol instead.
   */
  [RefSymbol]: true
}

/**
 * Checks if a value is a ref object.
 *
 * @param r - The value to inspect.
 * @see {@link https://vuejs.org/api/reactivity-utilities.html#isref}
 */
export function isRef<T>(r: Ref<T> | unknown): r is Ref<T>
/*@__NO_SIDE_EFFECTS__*/
export function isRef(r: any): r is Ref {
  return r ? r[ReactiveFlags.IS_REF] === true : false
}

/**
 * Takes an inner value and returns a reactive and mutable ref object, which
 * has a single property `.value` that points to the inner value.
 *
 * @param value - The object to wrap in the ref.
 * @see {@link https://vuejs.org/api/reactivity-core.html#ref}
 */
export function ref<T>(
  value: T,
): [T] extends [Ref] ? IfAny<T, Ref<T>, T> : Ref<UnwrapRef<T>, UnwrapRef<T> | T>
export function ref<T = any>(): Ref<T | undefined>
/*@__NO_SIDE_EFFECTS__*/
export function ref(value?: unknown) {
  return createRef(value, false)
}

declare const ShallowRefMarker: unique symbol

export type ShallowRef<T = any, S = T> = Ref<T, S> & {
  [ShallowRefMarker]?: true
}

/**
 * Shallow version of {@link ref}.
 *
 * @example
 * ```js
 * const state = shallowRef({ count: 1 })
 *
 * // does NOT trigger change
 * state.value.count = 2
 *
 * // does trigger change
 * state.value = { count: 2 }
 * ```
 *
 * @param value - The "inner value" for the shallow ref.
 * @see {@link https://vuejs.org/api/reactivity-advanced.html#shallowref}
 */
export function shallowRef<T>(
  value: T,
): Ref extends T
  ? T extends Ref
    ? IfAny<T, ShallowRef<T>, T>
    : ShallowRef<T>
  : ShallowRef<T>
export function shallowRef<T = any>(): ShallowRef<T | undefined>
/*@__NO_SIDE_EFFECTS__*/
export function shallowRef(value?: unknown) {
  return createRef(value, true)
}

function createRef(rawValue: unknown, shallow: boolean) {
  if (isRef(rawValue)) {
    return rawValue
  }
  return new RefImpl(rawValue, shallow)
}

/**
 * @internal
 */
class RefImpl<T = any> {
  _value: T
  private _rawValue: T

  // 每个 ref 自己的依赖源。与 computed 不同，它没有 Subscriber 身份——ref 不
  // 订阅别人，只被别人订阅。
  dep: Dep = new Dep()

  public readonly [ReactiveFlags.IS_REF] = true
  public readonly [ReactiveFlags.IS_SHALLOW]: boolean = false

  constructor(value: T, isShallow: boolean) {
    // 深 ref：_rawValue 存 toRaw(value)（比较用原始值），_value 存 toReactive(value)
    //（读出来是代理，嵌套属性才响应式）。浅 ref 两者都原样存。
    this._rawValue = isShallow ? value : toRaw(value)
    this._value = isShallow ? value : toReactive(value)
    this[ReactiveFlags.IS_SHALLOW] = isShallow
  }

  get value() {
    // 读 .value 就是一次 track；没有 activeSub 时 Dep.track() 自己会短路。
    if (__DEV__) {
      this.dep.track({
        target: this,
        type: TrackOpTypes.GET,
        key: 'value',
      })
    } else {
      this.dep.track()
    }
    return this._value
  }

  set value(newValue) {
    const oldValue = this._rawValue
    // 与 reactive 的写路径一致：深 ref 要把代理值拆成原始值再比较/存储，
    // 但浅值/只读值必须原样保留（否则会破坏只读语义与浅引用身份）。
    const useDirectValue =
      this[ReactiveFlags.IS_SHALLOW] ||
      isShallow(newValue) ||
      isReadonly(newValue)
    newValue = useDirectValue ? newValue : toRaw(newValue)
    // hasChanged 而不是 !==：正确处理 NaN（NaN !== NaN 但应视为未变）。
    if (hasChanged(newValue, oldValue)) {
      this._rawValue = newValue
      this._value = useDirectValue ? newValue : toReactive(newValue)
      if (__DEV__) {
        this.dep.trigger({
          target: this,
          type: TriggerOpTypes.SET,
          key: 'value',
          newValue,
          oldValue,
        })
      } else {
        this.dep.trigger()
      }
    }
  }
}

/**
 * Force trigger effects that depends on a shallow ref. This is typically used
 * after making deep mutations to the inner value of a shallow ref.
 *
 * @example
 * ```js
 * const shallow = shallowRef({
 *   greet: 'Hello, world'
 * })
 *
 * // Logs "Hello, world" once for the first run-through
 * watchEffect(() => {
 *   console.log(shallow.value.greet)
 * })
 *
 * // This won't trigger the effect because the ref is shallow
 * shallow.value.greet = 'Hello, universe'
 *
 * // Logs "Hello, universe"
 * triggerRef(shallow)
 * ```
 *
 * @param ref - The ref whose tied effects shall be executed.
 * @see {@link https://vuejs.org/api/reactivity-advanced.html#triggerref}
 */
export function triggerRef(ref: Ref): void {
  // ref may be an instance of ObjectRefImpl
  // 只对“自带 dep”的 ref 有效：ObjectRefImpl 的 dep 是从响应式源反查的，
  // 源没变时强行 trigger 会造出一个不存在的版本。
  if ((ref as unknown as RefImpl).dep) {
    if (__DEV__) {
      ;(ref as unknown as RefImpl).dep.trigger({
        target: ref,
        type: TriggerOpTypes.SET,
        key: 'value',
        newValue: (ref as unknown as RefImpl)._value,
      })
    } else {
      ;(ref as unknown as RefImpl).dep.trigger()
    }
  }
}

export type MaybeRef<T = any> =
  T | Ref<T> | ShallowRef<T> | WritableComputedRef<T>

export type MaybeRefOrGetter<T = any> = MaybeRef<T> | ComputedRef<T> | (() => T)

/**
 * Returns the inner value if the argument is a ref, otherwise return the
 * argument itself. This is a sugar function for
 * `val = isRef(val) ? val.value : val`.
 *
 * @example
 * ```js
 * function useFoo(x: number | Ref<number>) {
 *   const unwrapped = unref(x)
 *   // unwrapped is guaranteed to be number now
 * }
 * ```
 *
 * @param ref - Ref or plain value to be converted into the plain value.
 * @see {@link https://vuejs.org/api/reactivity-utilities.html#unref}
 */
export function unref<T>(ref: MaybeRef<T> | ComputedRef<T>): T {
  return isRef(ref) ? ref.value : ref
}

/**
 * Normalizes values / refs / getters to values.
 * This is similar to {@link unref}, except that it also normalizes getters.
 * If the argument is a getter, it will be invoked and its return value will
 * be returned.
 *
 * @example
 * ```js
 * toValue(1) // 1
 * toValue(ref(1)) // 1
 * toValue(() => 1) // 1
 * ```
 *
 * @param source - A getter, an existing ref, or a non-function value.
 * @see {@link https://vuejs.org/api/reactivity-utilities.html#tovalue}
 */
export function toValue<T>(source: MaybeRefOrGetter<T>): T {
  return isFunction(source) ? source() : unref(source)
}

const shallowUnwrapHandlers: ProxyHandler<any> = {
  // proxyRefs 只做“一层解包”：读属性时若值是 ref 就取 .value，写属性时若旧值
  // 是 ref 就写它的 .value。它不递归、不 track——依赖仍由源对象/内层 ref 负责。
  get: (target, key, receiver) =>
    key === ReactiveFlags.RAW
      ? target
      : unref(Reflect.get(target, key, receiver)),
  set: (target, key, value, receiver) => {
    const oldValue = target[key]
    if (isRef(oldValue) && !isRef(value)) {
      oldValue.value = value
      return true
    } else {
      return Reflect.set(target, key, value, receiver)
    }
  },
}

/**
 * Returns a proxy for the given object that shallowly unwraps properties that
 * are refs. If the object already is reactive, it's returned as-is. If not, a
 * new reactive proxy is created.
 *
 * @param objectWithRefs - Either an already-reactive object or a simple object
 * that contains refs.
 */
export function proxyRefs<T extends object>(
  objectWithRefs: T,
): ShallowUnwrapRef<T> {
  return isReactive(objectWithRefs)
    ? (objectWithRefs as ShallowUnwrapRef<T>)
    : new Proxy(objectWithRefs, shallowUnwrapHandlers)
}

export type CustomRefFactory<T, S = T> = (
  track: () => void,
  trigger: () => void,
) => {
  get: () => T
  set: (value: S) => void
}

class CustomRefImpl<T, S = T> {
  public dep: Dep

  private readonly _get: ReturnType<CustomRefFactory<T, S>>['get']
  private readonly _set: ReturnType<CustomRefFactory<T, S>>['set']

  public readonly [ReactiveFlags.IS_REF] = true

  public _value: T = undefined!

  constructor(factory: CustomRefFactory<T, S>) {
    const dep = (this.dep = new Dep())
    // 把 Dep 的两个原语直接交给用户：get 里调 track() 才算“读依赖”，set 里调
    // trigger() 才算“通知”。框架不插手，所以防抖/异步这类自定义时机才写得出来。
    const { get, set } = factory(dep.track.bind(dep), dep.trigger.bind(dep))
    this._get = get
    this._set = set
  }

  get value(): T {
    return (this._value = this._get())
  }

  set value(newVal: S) {
    this._set(newVal)
  }
}

/**
 * Creates a customized ref with explicit control over its dependency tracking
 * and updates triggering.
 *
 * @param factory - The function that receives the `track` and `trigger` callbacks.
 * @see {@link https://vuejs.org/api/reactivity-advanced.html#customref}
 */
export function customRef<T, S = T>(
  factory: CustomRefFactory<T, S>,
): Ref<T, S> {
  return new CustomRefImpl(factory) as any
}

export type ToRefs<T = any> = {
  [K in keyof T]: ToRef<T[K]>
}

type ArrayStringKey<T> = T extends readonly any[]
  ? number extends T['length']
    ? `${number}`
    : never
  : never

type ToRefKey<T> = keyof T | ArrayStringKey<T>

type ToRefValue<T extends object, K extends ToRefKey<T>> = K extends keyof T
  ? T[K]
  : T extends readonly (infer V)[]
    ? K extends ArrayStringKey<T>
      ? V
      : never
    : never

/**
 * Converts a reactive object to a plain object where each property of the
 * resulting object is a ref pointing to the corresponding property of the
 * original object. Each individual ref is created using {@link toRef}.
 *
 * @param object - Reactive object to be made into an object of linked refs.
 * @see {@link https://vuejs.org/api/reactivity-utilities.html#torefs}
 */
/*@__NO_SIDE_EFFECTS__*/
export function toRefs<T extends object>(object: T): ToRefs<T> {
  // 只接受代理：普通对象上的 toRefs 不会产生响应式连接（DEV 警告）。
  // 数组用长度预分配，避免 toRefs 产生稀疏数组；每个元素都用 ObjectRefImpl
  // 惰性指向源下标，不做任何值拷贝。
  if (__DEV__ && !isProxy(object)) {
    warn(`toRefs() expects a reactive object but received a plain one.`)
  }
  const ret: any = isArray(object) ? new Array(object.length) : {}
  for (const key in object) {
    ret[key] = propertyToRef(object, key)
  }
  return ret
}

class ObjectRefImpl<T extends object, K extends keyof T> {
  public readonly [ReactiveFlags.IS_REF] = true
  public _value: T[K] = undefined!

  private readonly _raw: T
  private readonly _key: K
  private readonly _shallow: boolean

  constructor(
    private readonly _object: T,
    key: K,
    private readonly _defaultValue?: T[K],
  ) {
    this._key = (isSymbol(key) ? key : String(key)) as K
    this._raw = toRaw(_object)

    let shallow = true
    let obj = _object

    // For an array with integer key, refs are not unwrapped
    // 数组整数下标的 ref 本来就不自动解包，无需判断。
    if (!isArray(_object) || isSymbol(this._key) || !isIntegerKey(this._key)) {
      // Otherwise, check each proxy layer for unwrapping
      // 从最外层逐层剥代理：只要遇到“非代理（链尾）”或“浅代理”，说明读到的
      // 值不会被自动解包，本类要自己 unref；若一路都是深代理，读到时就已解包。
      do {
        shallow = !isProxy(obj) || isShallow(obj)
      } while (shallow && (obj = (obj as Target)[ReactiveFlags.RAW]))
    }

    this._shallow = shallow
  }

  get value() {
    // 注意这里直接用 _object[key] 读：走的是源对象的 get 陷阱，因此依赖记在
    // 源属性上，而不是这个 ref 上。这也是 toRef 能和源对象“双向同步”的原因。
    let val = this._object[this._key]
    if (this._shallow) {
      val = unref(val)
    }
    return (this._value = val === undefined ? this._defaultValue! : val)
  }

  set value(newVal) {
    // 浅链路上属性本身就是 ref 时，写 .value 应写内层 ref 的 .value，而不是
    // 把整个 ref 替换掉（与 reactive set 里的 ref 处理保持同一语义）。
    if (this._shallow && isRef(this._raw[this._key])) {
      const nestedRef = this._object[this._key]
      if (isRef(nestedRef)) {
        nestedRef.value = newVal
        return
      }
    }

    this._object[this._key] = newVal
  }

  get dep(): Dep | undefined {
    // ObjectRefImpl 没有自己的 Dep：向全局 targetMap 反查源属性的 Dep。
    // 取不到（源属性从未被读过）就返回 undefined，triggerRef 会因此跳过。
    return getDepFromReactive(this._raw, this._key)
  }
}

class GetterRefImpl<T> {
  public readonly [ReactiveFlags.IS_REF] = true
  public readonly [ReactiveFlags.IS_READONLY] = true
  public _value: T = undefined!

  constructor(private readonly _getter: () => T) {}
  get value() {
    return (this._value = this._getter())
  }
}

export type ToRef<T> = IfAny<T, Ref<T>, [T] extends [Ref] ? T : Ref<T>>

/**
 * Used to normalize values / refs / getters into refs.
 *
 * @example
 * ```js
 * // returns existing refs as-is
 * toRef(existingRef)
 *
 * // creates a ref that calls the getter on .value access
 * toRef(() => props.foo)
 *
 * // creates normal refs from non-function values
 * // equivalent to ref(1)
 * toRef(1)
 * ```
 *
 * Can also be used to create a ref for a property on a source reactive object.
 * The created ref is synced with its source property: mutating the source
 * property will update the ref, and vice-versa.
 *
 * @example
 * ```js
 * const state = reactive({
 *   foo: 1,
 *   bar: 2
 * })
 *
 * const fooRef = toRef(state, 'foo')
 *
 * // mutating the ref updates the original
 * fooRef.value++
 * console.log(state.foo) // 2
 *
 * // mutating the original also updates the ref
 * state.foo++
 * console.log(fooRef.value) // 3
 * ```
 *
 * @param source - A getter, an existing ref, a non-function value, or a
 *                 reactive object to create a property ref from.
 * @param [key] - (optional) Name of the property in the reactive object.
 * @see {@link https://vuejs.org/api/reactivity-utilities.html#toref}
 */
export function toRef<T>(
  value: T,
): T extends () => infer R
  ? Readonly<Ref<R>>
  : T extends Ref
    ? T
    : Ref<UnwrapRef<T>>
export function toRef<T extends object, K extends ToRefKey<T>>(
  object: T,
  key: K,
): ToRef<ToRefValue<T, K>>
export function toRef<T extends object, K extends ToRefKey<T>>(
  object: T,
  key: K,
  defaultValue: ToRefValue<T, K>,
): ToRef<Exclude<ToRefValue<T, K>, undefined>>
/*@__NO_SIDE_EFFECTS__*/
export function toRef(
  source: Record<PropertyKey, any> | MaybeRef,
  key?: string | number | symbol,
  defaultValue?: unknown,
): Ref {
  if (isRef(source)) {
    return source
  } else if (isFunction(source)) {
    return new GetterRefImpl(source) as any
  } else if (isObject(source) && arguments.length > 1) {
    return propertyToRef(source, key!, defaultValue)
  } else {
    return ref(source)
  }
}

function propertyToRef(
  source: Record<PropertyKey, any>,
  key: string | number | symbol,
  defaultValue?: unknown,
) {
  return new ObjectRefImpl(source, key, defaultValue) as any
}

/**
 * This is a special exported interface for other packages to declare
 * additional types that should bail out for ref unwrapping. For example
 * \@vue/runtime-dom can declare it like so in its d.ts:
 *
 * ``` ts
 * declare module '@vue/reactivity' {
 *   export interface RefUnwrapBailTypes {
 *     runtimeDOMBailTypes: Node | Window
 *   }
 * }
 * ```
 */
export interface RefUnwrapBailTypes {}

export type ShallowUnwrapRef<T> = T extends ShallowReactiveBrand
  ? T
  : {
      [K in keyof T]: DistributeRef<T[K]>
    }

type DistributeRef<T> = T extends Ref<infer V, unknown> ? V : T

export type UnwrapRef<T> =
  T extends ShallowRef<infer V, unknown>
    ? V
    : T extends Ref<infer V, unknown>
      ? UnwrapRefSimple<V>
      : UnwrapRefSimple<T>

export type UnwrapRefSimple<T> = T extends
  | Builtin
  | Ref
  | RefUnwrapBailTypes[keyof RefUnwrapBailTypes]
  | { [RawSymbol]?: true }
  ? T
  : T extends ShallowReactiveBrand
    ? T
    : T extends Map<infer K, infer V>
      ? Map<K, UnwrapRefSimple<V>> & UnwrapRef<Omit<T, keyof Map<any, any>>>
      : T extends WeakMap<infer K, infer V>
        ? WeakMap<K, UnwrapRefSimple<V>> &
            UnwrapRef<Omit<T, keyof WeakMap<any, any>>>
        : T extends Set<infer V>
          ? Set<UnwrapRefSimple<V>> & UnwrapRef<Omit<T, keyof Set<any>>>
          : T extends WeakSet<infer V>
            ? WeakSet<UnwrapRefSimple<V>> &
                UnwrapRef<Omit<T, keyof WeakSet<any>>>
            : T extends ReadonlyArray<any>
              ? { [K in keyof T]: UnwrapRefSimple<T[K]> }
              : T extends object
                ? {
                    [P in keyof T]: P extends symbol ? T[P] : UnwrapRef<T[P]>
                  }
                : T
