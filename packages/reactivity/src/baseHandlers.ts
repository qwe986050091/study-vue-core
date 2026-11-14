// ============================================================================
// baseHandlers.ts：Object / Array 的 Proxy 陷阱
// ============================================================================
// 这是“读 → track、写 → trigger”真正发生的地方。读这个文件可以顺着两条线：
//   get 链：拦截标记 → 数组方法改写 → Reflect.get → 过滤不可追踪键 → track
//           → ref 解包 → 嵌套对象转代理
//   set 链：取旧值 → 特殊处理 ref/浅模式 → Reflect.set → 判断 ADD/SET
//           → hasChanged 才 trigger
//
// 几个设计点：
//   - 数组的迭代/查找方法被整体替换（arrayInstrumentations），因为原生方法在代理
//     上会把 this 当普通数组用，导致既漏依赖又漏解包；
//   - __v_isRef / __v_isReactive 等标记键直接返回、不 track，否则框架内部探测会
//     污染用户依赖；
//   - 深转换只在 get 里发生（惰性），写进去的值不会递归包装——写路径只存原始值
//     或在必要时 toRaw。
// ============================================================================

import {
  type Target,
  isReadonly,
  isShallow,
  reactive,
  reactiveMap,
  readonly,
  readonlyMap,
  shallowReactiveMap,
  shallowReadonlyMap,
  toRaw,
} from './reactive'
import { arrayInstrumentations } from './arrayInstrumentations'
import { ReactiveFlags, TrackOpTypes, TriggerOpTypes } from './constants'
import { ITERATE_KEY, track, trigger } from './dep'
import {
  hasChanged,
  hasOwn,
  isArray,
  isIntegerKey,
  isObject,
  isSymbol,
  makeMap,
} from '@vue/shared'
import { isRef } from './ref'
import { warn } from './warning'

const isNonTrackableKeys = /*@__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

// Symbol 上的内置方法（Symbol.iterator 等）不参与依赖收集：它们通常来自
// 语言层面的迭代协议，track 了也没有对应的触发点。
const builtInSymbols = /*@__PURE__*/ new Set(
  /*@__PURE__*/
  Object.getOwnPropertyNames(Symbol)
    // ios10.x Object.getOwnPropertyNames(Symbol) can enumerate 'arguments' and 'caller'
    // but accessing them on Symbol leads to TypeError because Symbol is a strict mode
    // function
    .filter(key => key !== 'arguments' && key !== 'caller')
    .map(key => Symbol[key as keyof SymbolConstructor])
    .filter(isSymbol),
)

function hasOwnProperty(this: object, key: unknown) {
  // #10455 hasOwnProperty may be called with non-string values
  // 替换掉代理对象上的 hasOwnProperty：原生实现不会经过 get 陷阱，直接调用就
  // 漏掉依赖。这里手动 track HAS，并且先 toRaw（用原始对象判断，避免代理身份
  // 影响结果）。
  if (!isSymbol(key)) key = String(key)
  const obj = toRaw(this)
  track(obj, TrackOpTypes.HAS, key)
  return obj.hasOwnProperty(key as string)
}

class BaseReactiveHandler implements ProxyHandler<Target> {
  constructor(
    protected readonly _isReadonly = false,
    protected readonly _isShallow = false,
  ) {}

  get(target: Target, key: string | symbol, receiver: object): any {
    // markRaw 的对象可能仍被读（例如作为 reactive 的属性）：SKIP 要能透传，
    // 否则 isReactive 判断会失真。
    if (key === ReactiveFlags.SKIP) return target[ReactiveFlags.SKIP]

    const isReadonly = this._isReadonly,
      isShallow = this._isShallow
    // 四个内部标记键走短路：它们既不是用户数据，也不该产生依赖。
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
    } else if (key === ReactiveFlags.IS_SHALLOW) {
      return isShallow
    } else if (key === ReactiveFlags.RAW) {
      // RAW 只有在“问的确实是本代理”时才返回原对象：
      //   receiver 等于该风味缓存里登记的那个代理 → 是本代理，交回 target；
      //   receiver 与 target 同原型（用户又在外面包了一层代理）→ 也认；
      // 否则裸 return undefined，避免把内部对象交给错误的接收者（例如从原型链
      // 继承访问时拿到别人的 raw）。
      if (
        receiver ===
          (isReadonly
            ? isShallow
              ? shallowReadonlyMap
              : readonlyMap
            : isShallow
              ? shallowReactiveMap
              : reactiveMap
          ).get(target) ||
        // receiver is not the reactive proxy, but has the same prototype
        // this means the receiver is a user proxy of the reactive proxy
        Object.getPrototypeOf(target) === Object.getPrototypeOf(receiver)
      ) {
        return target
      }
      // early return undefined
      // 注意是裸 return（undefined），不是原对象：让 isProxy 等探测不会误判。
      return
    }

    const targetIsArray = isArray(target)

    // 数组方法改写只对可写代理生效：只读代理的数组方法若被替换，返回值会变成
    // 可写视图，破坏只读语义。
    if (!isReadonly) {
      let fn: Function | undefined
      if (targetIsArray && (fn = arrayInstrumentations[key])) {
        return fn
      }
      if (key === 'hasOwnProperty') {
        return hasOwnProperty
      }
    }

    const res = Reflect.get(
      target,
      key,
      // if this is a proxy wrapping a ref, return methods using the raw ref
      // as receiver so that we don't have to call `toRaw` on the ref in all
      // its class methods
      // 普通对象用 receiver（保证 getter 里的 this 指向代理）；被代理的 ref 用
      // 原始 ref，避免 ref 的类方法每次都要 toRaw。
      isRef(target) ? target : receiver,
    )

    // 不可追踪键：内置 Symbol 与 __proto__ 等，直接返回，不建立依赖。
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }

    // 只读代理自身不 track：
    //   - 若它包的是 reactive 代理，Reflect.get 会穿透到内层，由内层 track；
    //   - 若它包的是普通对象，读只读视图不产生任何依赖（Vue 的既定行为）。
    if (!isReadonly) {
      track(target, TrackOpTypes.GET, key)
    }

    // 浅代理到此为止：属性值原样返回，不转代理、不解包 ref。
    if (isShallow) {
      return res
    }

    if (isRef(res)) {
      // ref unwrapping - skip unwrap for Array + integer key.
      // 解开嵌套 ref：obj.count 读出来是数字而不是 Ref。数组的整数下标例外，
      // 否则 arr[0] 会变成值本身，数组语义崩坏。
      const value = targetIsArray && isIntegerKey(key) ? res : res.value
      return isReadonly && isObject(value) ? readonly(value) : value
    }

    if (isObject(res)) {
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      // 深转换的落点：读到的嵌套对象按同样的风味再包一层。这里用直接调用而不是
      // 顶层导入的 toReactive，是为了让 readonly 风味也走同一条惰性路径。
      return isReadonly ? readonly(res) : reactive(res)
    }

    return res
  }
}

class MutableReactiveHandler extends BaseReactiveHandler {
  constructor(isShallow = false) {
    super(false, isShallow)
  }

  set(
    target: Record<string | symbol, unknown>,
    key: string | symbol,
    value: unknown,
    receiver: object,
  ): boolean {
    // 直接读 target[key]：这是原始对象，不会触发 get 陷阱，因此 set 自身不会
    // 建立依赖。数组整数下标单独标记，后面用它替代 hasOwn 判断（更快且能识别
    // “写到了空洞位置”）。
    let oldValue = target[key]
    const isArrayWithIntegerKey = isArray(target) && isIntegerKey(key)
    if (!this._isShallow) {
      const isOldValueReadonly = isReadonly(oldValue)
      // 深模式：写进去的代理值要拆成原始值，否则 targetMap 的键会变成代理，
      // 与读路径（用原始对象）对不上。只读/浅值例外，必须原样保留。
      if (!isShallow(value) && !isReadonly(value)) {
        oldValue = toRaw(oldValue)
        value = toRaw(value)
      }
      // 旧值是 ref、新值不是 ref 时，语义是“改 ref 的 value”而不是替换 ref。
      // 这是模板里 ref 自动解包能保持写回的原因。数组下标不做这个转换。
      if (!isArrayWithIntegerKey && isRef(oldValue) && !isRef(value)) {
        if (isOldValueReadonly) {
          if (__DEV__) {
            warn(
              `Set operation on key "${String(key)}" failed: target is readonly.`,
              target[key],
            )
          }
          return true
        } else {
          oldValue.value = value
          return true
        }
      }
    } else {
      // in shallow mode, objects are set as-is regardless of reactive or not
      // 浅模式不做任何 toRaw：写入什么就存什么。
    }

    // ADD 与 SET 的区分：数组整数下标不能用 hasOwn（稀疏数组的 hasOwn 判断
    // 与“是否越界追加”不一致），改用长度比较。
    const hadKey = isArrayWithIntegerKey
      ? Number(key) < target.length
      : hasOwn(target, key)
    const result = Reflect.set(
      target,
      key,
      value,
      isRef(target) ? target : receiver,
    )
    // don't trigger if target is something up in the prototype chain of original
    // 关键保护：如果这次 set 实际落在了 target 的原型上（receiver 不是 target
    // 自身），说明写的是继承来的 setter 或父对象，不该由本代理触发。
    if (target === toRaw(receiver) && result) {
      if (!hadKey) {
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        // 值没变就不通知：这是“赋相同值不触发更新”的落点，也是 computed
        // 能靠版本号省掉下游执行的前提。
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }

  deleteProperty(
    target: Record<string | symbol, unknown>,
    key: string | symbol,
  ): boolean {
    // 先记 hadKey 与旧值，再真正删除：trigger 需要旧值，删除后就读不到了。
    const hadKey = hasOwn(target, key)
    const oldValue = target[key]
    const result = Reflect.deleteProperty(target, key)
    // 只有“确实删掉了已存在的键”才通知：删除不存在的键是 no-op。
    if (result && hadKey) {
      trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
    }
    return result
  }

  has(target: Record<string | symbol, unknown>, key: string | symbol): boolean {
    // in 运算符走这里。内置 Symbol 与 __proto__ 等探测不记依赖。
    const result = Reflect.has(target, key)
    if (!isSymbol(key) || !builtInSymbols.has(key)) {
      track(target, TrackOpTypes.HAS, key)
    }
    return result
  }

  ownKeys(target: Record<string | symbol, unknown>): (string | symbol)[] {
    // Object.keys / for-in / JSON.stringify 的枚举走这里。它不针对某个键，而是
    // “整个对象的键集合”，所以记在 ITERATE_KEY 上；数组用 'length' 代替，
    // 因为数组的键集合变化等价于长度或下标变化，已有对应的通知路径。
    track(
      target,
      TrackOpTypes.ITERATE,
      isArray(target) ? 'length' : ITERATE_KEY,
    )
    return Reflect.ownKeys(target)
  }
}

class ReadonlyReactiveHandler extends BaseReactiveHandler {
  constructor(isShallow = false) {
    super(true, isShallow)
  }

  set(target: object, key: string | symbol) {
    // 只读代理的写入一律“成功返回但不生效”（返回 true 是 Proxy 规范要求，
    // 返回 false 会在严格模式抛 TypeError）。DEV 下额外警告。
    if (__DEV__) {
      warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target,
      )
    }
    return true
  }

  deleteProperty(target: object, key: string | symbol) {
    if (__DEV__) {
      warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target,
      )
    }
    return true
  }
}

export const mutableHandlers: ProxyHandler<object> =
  /*@__PURE__*/ new MutableReactiveHandler()

// 四个单例：handler 无状态，全仓复用，避免每个代理各建一份陷阱对象。
export const readonlyHandlers: ProxyHandler<object> =
  /*@__PURE__*/ new ReadonlyReactiveHandler()

export const shallowReactiveHandlers: MutableReactiveHandler =
  /*@__PURE__*/ new MutableReactiveHandler(true)

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
// 语境提醒：runtime-core 在 DEV 下用 shallowReadonly 给 props / attrs / slots
// 包只读视图（component.ts:885、componentPublicInstance.ts:408-411 等），顶层
// ref 不解包才能把 ref 原样透传给子组件；注意 instance.props 本身用的是
// shallowReactive（componentProps.ts:226），不是本 handler。
export const shallowReadonlyHandlers: ReadonlyReactiveHandler =
  /*@__PURE__*/ new ReadonlyReactiveHandler(true)
