// ============================================================================
// reactive.ts：代理工厂与四种“响应式风味”
// ============================================================================
// 本文件只做两件事：
//   1. 决定一个值要不要被 Proxy 包、包成哪一种（可写/只读 × 深/浅）；
//   2. 缓存代理，保证“同一个原始对象 + 同一种风味”只创建一个 Proxy。
//
// 四种风味与各自的缓存表：
//   reactive        → reactiveMap           可写、深、递归包装嵌套对象
//   shallowReactive → shallowReactiveMap    可写、浅、只代理第一层
//   readonly        → readonlyMap           只读、深、读到的对象继续 readonly
//   shallowReadonly → shallowReadonlyMap    只读、浅
// 缓存必须按风味分开：同一个原始对象可以同时有可写代理和只读代理，两者不是一回事。
//
// 深转换是惰性的：这里只包装传入的这一层，嵌套对象要等到 get 时由
// baseHandlers 再调 reactive()/readonly()，所以没被读到的子树不产生代理。
// 这与 MobX 的 observable 深转换不同——MobX 在定义时就把整棵树转成 observable。
// ============================================================================

import { def, hasOwn, isObject, toRawType } from '@vue/shared'
import {
  mutableHandlers,
  readonlyHandlers,
  shallowReactiveHandlers,
  shallowReadonlyHandlers,
} from './baseHandlers'
import {
  mutableCollectionHandlers,
  readonlyCollectionHandlers,
  shallowCollectionHandlers,
  shallowReadonlyCollectionHandlers,
} from './collectionHandlers'
import type { RawSymbol, Ref, UnwrapRefSimple } from './ref'
import { ReactiveFlags } from './constants'
import { warn } from './warning'

export interface Target {
  [ReactiveFlags.SKIP]?: boolean
  [ReactiveFlags.IS_REACTIVE]?: boolean
  [ReactiveFlags.IS_READONLY]?: boolean
  [ReactiveFlags.IS_SHALLOW]?: boolean
  [ReactiveFlags.RAW]?: any
}

export const reactiveMap: WeakMap<Target, any> = new WeakMap<Target, any>()
// 四张表都是 WeakMap：原始对象被回收后，对应的代理缓存自动消失。键是原始对象
// （不是 Proxy），所以代理自身的 ReactiveFlags.RAW 才能指回它。
export const shallowReactiveMap: WeakMap<Target, any> = new WeakMap<
  Target,
  any
>()
export const readonlyMap: WeakMap<Target, any> = new WeakMap<Target, any>()
export const shallowReadonlyMap: WeakMap<Target, any> = new WeakMap<
  Target,
  any
>()

enum TargetType {
  INVALID = 0,
  COMMON = 1,
  COLLECTION = 2,
}

// 只按“原始类型标签”分三档，不做鸭子类型判断：
//   Object/Array          → 走 baseHandlers（get/set/has/ownKeys 全套陷阱）
//   Map/Set/WeakMap/WeakSet → 走 collectionHandlers（只拦 get，返回改写后的方法）
//   其他（Date/RegExp/类实例等）→ 不代理，原样返回
// 这个分档是后面 createReactiveObject 拒绝代理的唯一依据。
function targetTypeMap(rawType: string) {
  switch (rawType) {
    case 'Object':
    case 'Array':
      return TargetType.COMMON
    case 'Map':
    case 'Set':
    case 'WeakMap':
    case 'WeakSet':
      return TargetType.COLLECTION
    default:
      return TargetType.INVALID
  }
}

// only unwrap nested ref
export type UnwrapNestedRefs<T> = T extends Ref ? T : UnwrapRefSimple<T>

declare const ReactiveMarkerSymbol: unique symbol

export interface ReactiveMarker {
  [ReactiveMarkerSymbol]?: void
}

export type Reactive<T> = UnwrapNestedRefs<T> &
  (T extends readonly any[] ? ReactiveMarker : {})

/**
 * Returns a reactive proxy of the object.
 *
 * The reactive conversion is "deep": it affects all nested properties. A
 * reactive object also deeply unwraps any properties that are refs while
 * maintaining reactivity.
 *
 * @example
 * ```js
 * const obj = reactive({ count: 0 })
 * ```
 *
 * @param target - The source object.
 * @see {@link https://vuejs.org/api/reactivity-core.html#reactive}
 */
export function reactive<T extends object>(target: T): Reactive<T>
/*@__NO_SIDE_EFFECTS__*/
export function reactive(target: object) {
  // if trying to observe a readonly proxy, return the readonly version.
  // 只读代理上再套可写代理会产生“能写但写不进去”的怪对象，直接原样返回。
  if (isReadonly(target)) {
    return target
  }
  return createReactiveObject(
    target,
    false,
    mutableHandlers,
    mutableCollectionHandlers,
    reactiveMap,
  )
}

// Use a private class brand instead of a marker property so shallow-reactive
// types remain distinguishable in `UnwrapRef` without leaking the brand into
// `keyof`/indexed access types or requiring the property for plain assignment.
declare class ShallowReactiveBrandClass {
  private __shallowReactiveBrand?: never
}

export type ShallowReactiveBrand = ShallowReactiveBrandClass

export type ShallowReactive<T> = T & ShallowReactiveBrand

/**
 * Shallow version of {@link reactive}.
 *
 * Unlike {@link reactive}, there is no deep conversion: only root-level
 * properties are reactive for a shallow reactive object. Property values are
 * stored and exposed as-is - this also means properties with ref values will
 * not be automatically unwrapped.
 *
 * @example
 * ```js
 * const state = shallowReactive({
 *   foo: 1,
 *   nested: {
 *     bar: 2
 *   }
 * })
 *
 * // mutating state's own properties is reactive
 * state.foo++
 *
 * // ...but does not convert nested objects
 * isReactive(state.nested) // false
 *
 * // NOT reactive
 * state.nested.bar++
 * ```
 *
 * @param target - The source object.
 * @see {@link https://vuejs.org/api/reactivity-advanced.html#shallowreactive}
 */
/*@__NO_SIDE_EFFECTS__*/
export function shallowReactive<T extends object>(
  target: T,
): ShallowReactive<T> {
  // 与 reactive 的唯一差别是 handler 与缓存表；仍然允许多层代理叠加（浅代理的
  // 属性值若本身是代理，读出来还是那个代理）。
  return createReactiveObject(
    target,
    false,
    shallowReactiveHandlers,
    shallowCollectionHandlers,
    shallowReactiveMap,
  )
}

type Primitive = string | number | boolean | bigint | symbol | undefined | null
export type Builtin = Primitive | Function | Date | Error | RegExp
export type DeepReadonly<T> = T extends Builtin
  ? T
  : T extends Map<infer K, infer V>
    ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
    : T extends ReadonlyMap<infer K, infer V>
      ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
      : T extends WeakMap<infer K, infer V>
        ? WeakMap<DeepReadonly<K>, DeepReadonly<V>>
        : T extends Set<infer U>
          ? ReadonlySet<DeepReadonly<U>>
          : T extends ReadonlySet<infer U>
            ? ReadonlySet<DeepReadonly<U>>
            : T extends WeakSet<infer U>
              ? WeakSet<DeepReadonly<U>>
              : T extends Promise<infer U>
                ? Promise<DeepReadonly<U>>
                : T extends Ref<infer U, unknown>
                  ? Readonly<Ref<DeepReadonly<U>>>
                  : T extends {}
                    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
                    : Readonly<T>

/**
 * Takes an object (reactive or plain) or a ref and returns a readonly proxy to
 * the original.
 *
 * A readonly proxy is deep: any nested property accessed will be readonly as
 * well. It also has the same ref-unwrapping behavior as {@link reactive},
 * except the unwrapped values will also be made readonly.
 *
 * @example
 * ```js
 * const original = reactive({ count: 0 })
 *
 * const copy = readonly(original)
 *
 * watchEffect(() => {
 *   // works for reactivity tracking
 *   console.log(copy.count)
 * })
 *
 * // mutating original will trigger watchers relying on the copy
 * original.count++
 *
 * // mutating the copy will fail and result in a warning
 * copy.count++ // warning!
 * ```
 *
 * @param target - The source object.
 * @see {@link https://vuejs.org/api/reactivity-core.html#readonly}
 */
/*@__NO_SIDE_EFFECTS__*/
export function readonly<T extends object>(
  target: T,
): DeepReadonly<UnwrapNestedRefs<T>> {
  // 只读代理没有任何写入路径（handler 的 set/delete 只警告不落盘），但读仍然
  // 会 track：只读视图本身也可以作为依赖来源，源对象变化时订阅者照样重跑。
  return createReactiveObject(
    target,
    true,
    readonlyHandlers,
    readonlyCollectionHandlers,
    readonlyMap,
  )
}

/**
 * Shallow version of {@link readonly}.
 *
 * Unlike {@link readonly}, there is no deep conversion: only root-level
 * properties are made readonly. Property values are stored and exposed as-is -
 * this also means properties with ref values will not be automatically
 * unwrapped.
 *
 * @example
 * ```js
 * const state = shallowReadonly({
 *   foo: 1,
 *   nested: {
 *     bar: 2
 *   }
 * })
 *
 * // mutating state's own properties will fail
 * state.foo++
 *
 * // ...but works on nested objects
 * isReadonly(state.nested) // false
 *
 * // works
 * state.nested.bar++
 * ```
 *
 * @param target - The source object.
 * @see {@link https://vuejs.org/api/reactivity-advanced.html#shallowreadonly}
 */
/*@__NO_SIDE_EFFECTS__*/
export function shallowReadonly<T extends object>(target: T): Readonly<T> {
  return createReactiveObject(
    target,
    true,
    shallowReadonlyHandlers,
    shallowReadonlyCollectionHandlers,
    shallowReadonlyMap,
  )
}

function createReactiveObject(
  target: Target,
  isReadonly: boolean,
  baseHandlers: ProxyHandler<any>,
  collectionHandlers: ProxyHandler<any>,
  proxyMap: WeakMap<Target, any>,
) {
  // 下面五个 if 的顺序就是“拦截优先级”，每一条都会原样返回而不抛错：
  // 1) 非对象（含 null）：Proxy 只能包对象；
  if (!isObject(target)) {
    if (__DEV__) {
      warn(
        `value cannot be made ${isReadonly ? 'readonly' : 'reactive'}: ${String(
          target,
        )}`,
      )
    }
    return target
  }
  // target is already a Proxy, return it.
  // exception: calling readonly() on a reactive object
  // 2) 已经是本库的代理：直接复用。唯一的例外是 readonly(reactiveObj)——
  //    需要一个只读视图，不能返回原可写代理。
  if (
    target[ReactiveFlags.RAW] &&
    !(isReadonly && target[ReactiveFlags.IS_REACTIVE])
  ) {
    return target
  }
  // only specific value types can be observed.
  // 3) markRaw 标记过，或对象被冻结/不可扩展：不代理（Proxy 写入会失败，且
  //    Object.freeze 的对象本就不该被观察）。
  if (target[ReactiveFlags.SKIP] || !Object.isExtensible(target)) {
    return target
  }
  // target already has corresponding Proxy
  // 4) 同一风味已有缓存：复用，保证 identity 稳定（a === reactive(raw)）。
  const existingProxy = proxyMap.get(target)
  if (existingProxy) {
    return existingProxy
  }
  // 5) 类型不在白名单内：不代理。
  const targetType = targetTypeMap(toRawType(target))
  if (targetType === TargetType.INVALID) {
    return target
  }
  // 集合与普通对象需要完全不同的陷阱集，所以在这里二选一；创建后立刻入缓存，
  // 避免递归包装同一对象时无限创建。
  const proxy = new Proxy(
    target,
    targetType === TargetType.COLLECTION ? collectionHandlers : baseHandlers,
  )
  proxyMap.set(target, proxy)
  return proxy
}

/**
 * Checks if an object is a proxy created by {@link reactive} or
 * {@link shallowReactive} (or {@link ref} in some cases).
 *
 * @example
 * ```js
 * isReactive(reactive({}))            // => true
 * isReactive(readonly(reactive({})))  // => true
 * isReactive(ref({}).value)           // => true
 * isReactive(readonly(ref({})).value) // => true
 * isReactive(ref(true))               // => false
 * isReactive(shallowRef({}).value)    // => false
 * isReactive(shallowReactive({}))     // => true
 * ```
 *
 * @param value - The value to check.
 * @see {@link https://vuejs.org/api/reactivity-utilities.html#isreactive}
 */
/*@__NO_SIDE_EFFECTS__*/
export function isReactive(value: unknown): boolean {
  // 只读代理自身没有 IS_REACTIVE，但它底层可能是 reactive：先剥一层 RAW 再问。
  // 因此 readonly(reactive(obj)) 对 isReactive 回答 true，而 readonly(obj) 回答 false。
  if (isReadonly(value)) {
    return isReactive((value as Target)[ReactiveFlags.RAW])
  }
  return !!(value && (value as Target)[ReactiveFlags.IS_REACTIVE])
}

/**
 * Checks whether the passed value is a readonly object. The properties of a
 * readonly object can change, but they can't be assigned directly via the
 * passed object.
 *
 * The proxies created by {@link readonly} and {@link shallowReadonly} are
 * both considered readonly, as is a computed ref without a set function.
 *
 * @param value - The value to check.
 * @see {@link https://vuejs.org/api/reactivity-utilities.html#isreadonly}
 */
/*@__NO_SIDE_EFFECTS__*/
export function isReadonly(value: unknown): boolean {
  return !!(value && (value as Target)[ReactiveFlags.IS_READONLY])
}

/*@__NO_SIDE_EFFECTS__*/
export function isShallow(value: unknown): boolean {
  return !!(value && (value as Target)[ReactiveFlags.IS_SHALLOW])
}

/**
 * Checks if an object is a proxy created by {@link reactive},
 * {@link readonly}, {@link shallowReactive} or {@link shallowReadonly}.
 *
 * @param value - The value to check.
 * @see {@link https://vuejs.org/api/reactivity-utilities.html#isproxy}
 */
/*@__NO_SIDE_EFFECTS__*/
export function isProxy(value: any): boolean {
  // 比 isReactive/isReadonly 更宽：只要有 RAW 标记就是（可写或只读）代理。
  // ref 不是 Proxy，所以 isProxy(ref(1)) 为 false。
  return value ? !!value[ReactiveFlags.RAW] : false
}

/**
 * Returns the raw, original object of a Vue-created proxy.
 *
 * `toRaw()` can return the original object from proxies created by
 * {@link reactive}, {@link readonly}, {@link shallowReactive} or
 * {@link shallowReadonly}.
 *
 * This is an escape hatch that can be used to temporarily read without
 * incurring proxy access / tracking overhead or write without triggering
 * changes. It is **not** recommended to hold a persistent reference to the
 * original object. Use with caution.
 *
 * @example
 * ```js
 * const foo = {}
 * const reactiveFoo = reactive(foo)
 *
 * console.log(toRaw(reactiveFoo) === foo) // true
 * ```
 *
 * @param observed - The object for which the "raw" value is requested.
 * @see {@link https://vuejs.org/api/reactivity-advanced.html#toraw}
 */
/*@__NO_SIDE_EFFECTS__*/
export function toRaw<T>(observed: T): T {
  // 递归剥：readonly(reactive(raw)) 有两层，一次 RAW 只回到内层代理。
  // 这是“绕过代理、直接读原始值”的逃生口，也因此不会触发 track。
  const raw = observed && (observed as Target)[ReactiveFlags.RAW]
  return raw ? toRaw(raw) : observed
}

export type Raw<T> = T & { [RawSymbol]?: true }

/**
 * Marks an object so that it will never be converted to a proxy. Returns the
 * object itself.
 *
 * @example
 * ```js
 * const foo = markRaw({})
 * console.log(isReactive(reactive(foo))) // false
 *
 * // also works when nested inside other reactive objects
 * const bar = reactive({ foo })
 * console.log(isReactive(bar.foo)) // false
 * ```
 *
 * **Warning:** `markRaw()` together with the shallow APIs such as
 * {@link shallowReactive} allow you to selectively opt-out of the default
 * deep reactive/readonly conversion and embed raw, non-proxied objects in your
 * state graph.
 *
 * @param value - The object to be marked as "raw".
 * @see {@link https://vuejs.org/api/reactivity-advanced.html#markraw}
 */
export function markRaw<T extends object>(value: T): Raw<T> {
  // 标记写成一个不可枚举的自有属性，createReactiveObject 第一道检查就会放行。
  // 为什么还要求 isExtensible：不可扩展对象加不了属性，标了也没用。
  if (!hasOwn(value, ReactiveFlags.SKIP) && Object.isExtensible(value)) {
    def(value, ReactiveFlags.SKIP, true)
  }
  return value
}

/**
 * Returns a reactive proxy of the given value (if possible).
 *
 * If the given value is not an object, the original value itself is returned.
 *
 * @param value - The value for which a reactive proxy shall be created.
 */
export const toReactive = <T extends unknown>(value: T): T =>
  // 被 baseHandlers/ref/collectionHandlers 用来做“读时深转换”：只有对象才包装，
  // 原始值原样返回。惰性代理的落点就在这一行。
  isObject(value) ? reactive(value) : value

/**
 * Returns a readonly proxy of the given value (if possible).
 *
 * If the given value is not an object, the original value itself is returned.
 *
 * @param value - The value for which a readonly proxy shall be created.
 */
export const toReadonly = <T extends unknown>(value: T): DeepReadonly<T> =>
  isObject(value) ? readonly(value) : (value as DeepReadonly<T>)
