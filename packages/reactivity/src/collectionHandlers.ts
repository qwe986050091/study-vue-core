// ============================================================================
// collectionHandlers.ts：Map / Set / WeakMap / WeakSet 的代理
// ============================================================================
// 集合不能像普通对象那样用 get/set 陷阱逐键拦截：Map 的读写都发生在方法内部
// （map.get(k)、map.set(k, v)），根本不会触发属性级 get/set。所以这里的策略是
// 只拦一个 get 陷阱，把 get/set/has/add/delete/clear/迭代器等方法整体替换成
// instrumented 版本（见 createInstrumentations）。
//
// 每条替换方法都遵守同一套骨架：
//   1. this[RAW] 拿到原始集合，toRaw 再去一层（可能被多层代理包着）；
//   2. 原始值 / 原始键的归一化：写进去的代理要 toRaw，读的时候两种键都试；
//   3. 读方法先 track（GET/HAS/ITERATE），写方法先执行、后 trigger；
//   4. 返回值按风味（shallow / readonly / reactive）包装。
//
// 注意 WeakMap/WeakSet 也走这里，但它们不可遍历，所以只有 get/has/set/add/delete
// 这些单键方法真正有意义；迭代方法对它们调用本来就会抛错。
// 另外，集合代理不会拦截 ownKeys/set/deleteProperty：Map 的键不是对象属性，
// 这些陷阱对集合语义没有意义，拦了反而会让 Object.keys(map) 这类操作行为怪异。
// ============================================================================

import {
  type Target,
  isReadonly,
  isShallow,
  toRaw,
  toReactive,
  toReadonly,
} from './reactive'
import { ITERATE_KEY, MAP_KEY_ITERATE_KEY, track, trigger } from './dep'
import { ReactiveFlags, TrackOpTypes, TriggerOpTypes } from './constants'
import {
  capitalize,
  extend,
  hasChanged,
  hasOwn,
  isMap,
  toRawType,
} from '@vue/shared'
import { warn } from './warning'

type CollectionTypes = IterableCollections | WeakCollections

// 四个类型别名把 Map/Set/WeakMap/WeakSet 交叉上 Target，只是为了拿到
// ReactiveFlags 那几个可选属性；运行时没有任何额外包装。
type IterableCollections = (Map<any, any> | Set<any>) & Target
type WeakCollections = (WeakMap<any, any> | WeakSet<any>) & Target
type MapTypes = (Map<any, any> | WeakMap<any, any>) & Target
type SetTypes = (Set<any> | WeakSet<any>) & Target

const toShallow = <T extends unknown>(value: T): T => value

// 所有“取原型上的原生方法”都走 Reflect.getPrototypeOf，而不是直接 target.has：
// 这样用户自定义 Map 子类覆盖的方法也能被拿到（#11759 同类问题在数组那边）。
const getProto = <T extends CollectionTypes>(v: T): any =>
  Reflect.getPrototypeOf(v)

function createIterableMethod(
  method: string | symbol,
  isReadonly: boolean,
  isShallow: boolean,
) {
  // 返回一个“包装过的迭代器工厂”。为什么不直接把原生迭代器交给用户：
  //   1. 原生迭代器吐的是原始集合里的值，用户应看到代理/只读版本；
  //   2. 迭代本身要建立 ITERATE 依赖，原生迭代不经过 trap。
  return function (
    this: IterableCollections,
    ...args: unknown[]
  ): Iterable<unknown> & Iterator<unknown> {
    const target = this[ReactiveFlags.RAW]
    const rawTarget = toRaw(target)
    const targetIsMap = isMap(rawTarget)
    // entries / Symbol.iterator（Map 的默认迭代器）产出 [k, v] 对；keys 单独一类
    // 用来区分 MAP_KEY_ITERATE_KEY。
    const isPair =
      method === 'entries' || (method === Symbol.iterator && targetIsMap)
    const isKeyOnly = method === 'keys' && targetIsMap
    const innerIterator = target[method](...args)
    // 值的包装策略由风味决定：浅 → 原样；只读 → readonly；否则 → reactive。
    const wrap = isShallow ? toShallow : isReadonly ? toReadonly : toReactive
    // 只读迭代不 track（与 baseHandlers 的约定一致：只读视图不作为依赖来源）。
    !isReadonly &&
      track(
        rawTarget,
        TrackOpTypes.ITERATE,
        isKeyOnly ? MAP_KEY_ITERATE_KEY : ITERATE_KEY,
      )
    // return a wrapped iterator which returns observed versions of the
    // values emitted from the real iterator
    // Object.create(innerIterator) 继承迭代器的全部协议（Symbol.iterator 返回
    // 自身），只覆盖 next；这样 for...of、展开、解构都能正常工作。
    // 这里包装的是“迭代器对象”，不是集合本身：集合的每次迭代都会新建一个
    // 迭代器，因此包装成本只在真正开始迭代时产生。
    return extend(
      // inheriting all iterator properties
      Object.create(innerIterator),
      {
        // iterator protocol
        next() {
          const { value, done } = innerIterator.next()
          return done
            ? { value, done }
            : {
                value: isPair ? [wrap(value[0]), wrap(value[1])] : wrap(value),
                done,
              }
        },
      },
    )
  }
}

function createReadonlyMethod(type: TriggerOpTypes): Function {
  // 只读集合的写方法：不落盘、DEV 警告，并按各方法约定的返回值返回：
  // delete → false；clear → undefined；add/set → this（支持链式调用）。
  // 生产构建里连警告都没有，只剩一个“什么都不做”的空壳。
  return function (this: CollectionTypes, ...args: unknown[]) {
    if (__DEV__) {
      const key = args[0] ? `on key "${args[0]}" ` : ``
      warn(
        `${capitalize(type)} operation ${key}failed: target is readonly.`,
        toRaw(this),
      )
    }
    return type === TriggerOpTypes.DELETE
      ? false
      : type === TriggerOpTypes.CLEAR
        ? undefined
        : this
  }
}

type Instrumentations = Record<string | symbol, Function | number>
// 注意 Record 的值类型包含 number：getter（size）在对象字面量里是访问器，
// 类型上只能宽松描述；运行时会正常求值成数字。

function createInstrumentations(
  readonly: boolean,
  shallow: boolean,
): Instrumentations {
  // 一次生成一整组方法。ro = 只读、shallow = 浅，两个布尔排列出四种风味；
  // 每组只建一次（模块加载时），后续所有同风味集合共享同一批函数对象。
  // 函数体里的 `this` 在调用时才是具体的代理实例。
  // 从这里往下三个 getter / 方法都遵循同一约定：
  //   读操作先 track 再读原始集合；写操作先写原始集合再 trigger；
  //   返回值一律按当前风味包装。
  const instrumentations: Instrumentations = {
    get(this: MapTypes, key: unknown) {
      // #1772: readonly(reactive(Map)) should return readonly + reactive version
      // of the value
      // get 的返回值也要按风味包装：集合里存的是原始对象，读出来必须是代理，
      // 否则用户拿到原始对象改它不会触发更新。
      const target = this[ReactiveFlags.RAW]
      const rawTarget = toRaw(target)
      const rawKey = toRaw(key)
      if (!readonly) {
        // 键可能是代理也可能是原始值。两种都 track：因为用户下次可能用另一种
        // 形式读写，只记一种会漏触发。
        if (hasChanged(key, rawKey)) {
          track(rawTarget, TrackOpTypes.GET, key)
        }
        track(rawTarget, TrackOpTypes.GET, rawKey)
      }
      const { has } = getProto(rawTarget)
      const wrap = shallow ? toShallow : readonly ? toReadonly : toReactive
      // 先用原样的 key 查（可能是代理键），查不到再用 rawKey 兜底。两条分支
      // 对应“集合里存的是原始值”与“存的是代理”两种历史数据。
      if (has.call(rawTarget, key)) {
        return wrap(target.get(key))
      } else if (has.call(rawTarget, rawKey)) {
        return wrap(target.get(rawKey))
      } else if (target !== rawTarget) {
        // #3602 readonly(reactive(Map))
        // ensure that the nested reactive `Map` can do tracking for itself
        // 只读代理包着 reactive Map 时，直接走内层，让内层完成 track。
        target.get(key)
      }
    },
    get size() {
      // size 是“整表遍历”的等价信息，记在 ITERATE_KEY 上：任何增删都要让它失效。
      const target = (this as unknown as IterableCollections)[ReactiveFlags.RAW]
      !readonly && track(toRaw(target), TrackOpTypes.ITERATE, ITERATE_KEY)
      return target.size
    },
    has(this: CollectionTypes, key: unknown): boolean {
      const target = this[ReactiveFlags.RAW]
      const rawTarget = toRaw(target)
      const rawKey = toRaw(key)
      if (!readonly) {
        // 与 get 相同：key / rawKey 两种形态都记 HAS 依赖。
        if (hasChanged(key, rawKey)) {
          track(rawTarget, TrackOpTypes.HAS, key)
        }
        track(rawTarget, TrackOpTypes.HAS, rawKey)
      }
      // 判断时两种键都要问，原因同上；key === rawKey 时只查一次。
      return key === rawKey
        ? target.has(key)
        : target.has(key) || target.has(rawKey)
    },
    forEach(this: IterableCollections, callback: Function, thisArg?: unknown) {
      const observed = this
      const target = observed[ReactiveFlags.RAW]
      const rawTarget = toRaw(target)
      const wrap = shallow ? toShallow : readonly ? toReadonly : toReactive
      !readonly && track(rawTarget, TrackOpTypes.ITERATE, ITERATE_KEY)
      return target.forEach((value: unknown, key: unknown) => {
        // important: make sure the callback is
        // 1. invoked with the reactive map as `this` and 3rd arg
        // 2. the value received should be a corresponding reactive/readonly.
        // 第三参数传 observed（代理本身）而不是 rawTarget：用户回调里若继续操作
        // 集合，应该继续走代理、继续收集依赖。
        return callback.call(thisArg, wrap(value), wrap(key), observed)
      })
    },
  }

  // 写方法按风味二选一：只读组全部替换成“警告 + 空操作”，可写组走真实的
  // 归一化 → 原生方法 → trigger 流程。两组共用 get/size/has/forEach 与迭代器。
  extend(
    instrumentations,
    readonly
      ? {
          add: createReadonlyMethod(TriggerOpTypes.ADD),
          set: createReadonlyMethod(TriggerOpTypes.SET),
          delete: createReadonlyMethod(TriggerOpTypes.DELETE),
          clear: createReadonlyMethod(TriggerOpTypes.CLEAR),
        }
      : {
          add(this: SetTypes, value: unknown) {
            // 写入前归一化：非浅、非浅值、非只读值 → 存原始值，保证集合里不会
            // 混入代理（否则 has/delete 用原始值查不到）。
            const target = toRaw(this)
            const proto = getProto(target)
            const rawValue = toRaw(value)
            const valueToAdd =
              !shallow && !isShallow(value) && !isReadonly(value)
                ? rawValue
                : value
            // 已存在则完全不动：Set.add 本身幂等，触发只会造成无意义刷新。
            const hadKey =
              proto.has.call(target, valueToAdd) ||
              (hasChanged(value, valueToAdd) &&
                proto.has.call(target, value)) ||
              (hasChanged(rawValue, valueToAdd) &&
                proto.has.call(target, rawValue))
            if (!hadKey) {
              target.add(valueToAdd)
              trigger(target, TriggerOpTypes.ADD, valueToAdd, valueToAdd)
            }
            return this
          },
          set(this: MapTypes, key: unknown, value: unknown) {
            if (!shallow && !isShallow(value) && !isReadonly(value)) {
              value = toRaw(value)
            }
            const target = toRaw(this)
            const { has, get } = getProto(target)

            // 键与 add 一样要做“原始/代理”两种形态的存在性判断。
            let hadKey = has.call(target, key)
            if (!hadKey) {
              key = toRaw(key)
              hadKey = has.call(target, key)
            } else if (__DEV__) {
              checkIdentityKeys(target, has, key)
            }

            // 旧值必须在 set 之前取；之后只按“键是否存在 + 值是否变化”决定
            // 发 ADD 还是 SET，两条都不满足就静默。
            const oldValue = get.call(target, key)
            target.set(key, value)
            if (!hadKey) {
              trigger(target, TriggerOpTypes.ADD, key, value)
            } else if (hasChanged(value, oldValue)) {
              trigger(target, TriggerOpTypes.SET, key, value, oldValue)
            }
            return this
          },
          delete(this: CollectionTypes, key: unknown) {
            const target = toRaw(this)
            const { has, get } = getProto(target)
            let hadKey = has.call(target, key)
            if (!hadKey) {
              key = toRaw(key)
              hadKey = has.call(target, key)
            } else if (__DEV__) {
              checkIdentityKeys(target, has, key)
            }

            // Set 没有 get，oldValue 为 undefined；Map 才有删除前的值。
            const oldValue = get ? get.call(target, key) : undefined
            // forward the operation before queueing reactions
            // 先执行删除再 trigger：订阅者重跑时看到的是删除后的状态。
            const result = target.delete(key)
            if (hadKey) {
              trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
            }
            return result
          },
          clear(this: IterableCollections) {
            const target = toRaw(this)
            const hadItems = target.size !== 0
            // DEV 下把清空前的快照塞进调试事件；生产环境不复制整表。
            const oldTarget = __DEV__
              ? isMap(target)
                ? new Map(target)
                : new Set(target)
              : undefined
            // forward the operation before queueing reactions
            const result = target.clear()
            // 空集合 clear 不产生通知（没有实际变化）。
            if (hadItems) {
              trigger(
                target,
                TriggerOpTypes.CLEAR,
                undefined,
                undefined,
                oldTarget,
              )
            }
            return result
          },
        },
  )

  const iteratorMethods = [
    'keys',
    'values',
    'entries',
    Symbol.iterator,
  ] as const

  // 四个迭代方法单独生成：它们共享 createIterableMethod 的包装逻辑，只是
  // 键/值对的形态与 track 用的伪键不同。
  iteratorMethods.forEach(method => {
    instrumentations[method] = createIterableMethod(method, readonly, shallow)
  })

  return instrumentations
}

function createInstrumentationGetter(isReadonly: boolean, shallow: boolean) {
  // 每个风味一份 instrumentations，只创建一次（下方四个导出的 handler 各调一次）。
  const instrumentations = createInstrumentations(isReadonly, shallow)

  // 集合代理只有 get 一个陷阱：所有方法都是“读出来再调用”，拦 get 就够了。
  return (
    target: CollectionTypes,
    key: string | symbol,
    receiver: CollectionTypes,
  ) => {
    // 四个内部标记键同样短路，不透传给原始集合。
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
    } else if (key === ReactiveFlags.IS_SHALLOW) {
      return shallow
    } else if (key === ReactiveFlags.RAW) {
      return target
    }

    // 只有当 instrumentations 里有这个键、且目标上确实存在同名成员时才用改写
    // 版本；否则回落到原始对象（例如用户自己挂在 Map 实例上的属性）。
    // receiver 透传，保证方法里的 this 仍然是代理。
    return Reflect.get(
      hasOwn(instrumentations, key) && key in target
        ? instrumentations
        : target,
      key,
      receiver,
    )
  }
}

// 四个导出的 handler 都只有一个 get 陷阱：
//   Map/Set 的“属性”语义几乎全部由方法承载，没有可拦的 key 级 get/set；
//   真正要拦的只有 Symbol.iterator / size 这类访问，也都能在 get 里分派。
export const mutableCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: /*@__PURE__*/ createInstrumentationGetter(false, false),
}

export const shallowCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: /*@__PURE__*/ createInstrumentationGetter(false, true),
}

export const readonlyCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: /*@__PURE__*/ createInstrumentationGetter(true, false),
}

export const shallowReadonlyCollectionHandlers: ProxyHandler<CollectionTypes> =
  {
    get: /*@__PURE__*/ createInstrumentationGetter(true, true),
  }

function checkIdentityKeys(
  target: CollectionTypes,
  has: (key: unknown) => boolean,
  key: unknown,
) {
  // DEV 检查：同一个 Map/Set 里同时存在原始对象和它的代理版本作为键。这在
  // JS 里是合法但几乎必然出错的用法（两个键互不相等），所以只警告不阻止。
  // 只在“键已存在且 key 本身是代理”的分支调用，避免误报。
  const rawKey = toRaw(key)
  if (rawKey !== key && has.call(target, rawKey)) {
    const type = toRawType(target)
    warn(
      `Reactive ${type} contains both the raw and reactive ` +
        `versions of the same object${type === `Map` ? ` as keys` : ``}, ` +
        `which can lead to inconsistencies. ` +
        `Avoid differentiating between the raw and reactive versions ` +
        `of an object and only use the reactive version if possible.`,
    )
  }
}
