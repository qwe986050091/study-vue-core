// ============================================================================
// arrayInstrumentations.ts：数组方法的改写
// ============================================================================
// 原生数组方法在代理上直接跑会有两类问题：
//   1. 漏依赖：map/filter/forEach 内部按索引读元素，读的是 this（代理）还是原始
//      数组取决于方法实现，有的路径不经过 get 陷阱；
//   2. 漏解包：回调拿到的元素应是代理（或只读代理），原生方法给的是原始值。
// 因此这里把数组方法整体换掉，分成四种策略：
//   reactiveReadArray / shallowReadArray —— 整表读：先 track ARRAY_ITERATE，
//       再用原始数组批量操作，避免逐下标建依赖（一个 1000 元素数组只建 1 条）；
//   iterator —— 迭代器：包装 next() 的返回值；
//   apply / reduce —— 回调型：把回调和返回值都做代理包装；
//   searchProxy —— 身份敏感：先用代理参数找，找不到再用 raw 参数重试；
//   noTracking —— 变更型：push/pop/splice 等会读 length，必须暂停收集，
//       否则 effect 会把自己写入的长度当成依赖（issue #2137）。
//
// 与 MobX 的差别（只提一句）：MobX 的 observable array 是自定义集合类型，方法
// 本来就可控；Vue 保持原生数组 + 方法改写，所以要在“像原生”上做这么多补丁。
// ============================================================================

import { TrackOpTypes } from './constants'
import { endBatch, pauseTracking, resetTracking, startBatch } from './effect'
import {
  isProxy,
  isReactive,
  isReadonly,
  isShallow,
  toRaw,
  toReactive,
  toReadonly,
} from './reactive'
import { ARRAY_ITERATE_KEY, track } from './dep'
import { isArray } from '@vue/shared'

/**
 * Track array iteration and return:
 * - if input is reactive: a cloned raw array with reactive values
 * - if input is readonly: a cloned raw array with readonly values, preserving
 *   reactivity
 * - if input is raw or shallow: the original raw array
 */
export function reactiveReadArray<T>(array: T[]): T[] {
  const raw = toRaw(array)
  // 传入的本来就是原始数组（或浅代理）：没有代理层要剥，直接返回，不 track。
  if (raw === array) return raw
  // 只记一条“数组迭代”依赖，而不是 length + 每个下标。这是数组方法能保持
  // 低依赖数的核心：trigger 侧对任意数字下标都会通知 ARRAY_ITERATE_KEY。
  track(raw, TrackOpTypes.ITERATE, ARRAY_ITERATE_KEY)
  if (isShallow(array)) return raw
  // 可写代理：返回一份“元素已转成 reactive”的新数组；调用方在这个副本上跑
  // 原生方法，既拿到代理元素，又不会把内部读操作记成依赖。
  if (!isReadonly(array)) return raw.map(toReactive)

  // Preserve proxy layers without checking the array's flags for every element.
  // 只读代理包 reactive 时保留两层（readonly(reactive(item))），否则只加一层
  // readonly。这里按数组整体风味决定，避免逐元素 isReactive 判断。
  return (
    isReactive(array)
      ? raw.map(item => toReadonly(toReactive(item)))
      : raw.map(toReadonly)
  ) as T[]
}

/**
 * Track array iteration and return raw array
 */
export function shallowReadArray<T>(arr: T[]): T[] {
  // 浅路径：只 track、只返回原始数组，元素不包装。apply/iterator 在“不需要
  // 包装”的分支里用它，省掉一次 map 拷贝。
  track((arr = toRaw(arr)), TrackOpTypes.ITERATE, ARRAY_ITERATE_KEY)
  return arr
}

function toWrapped(target: unknown, item: unknown) {
  // 单个元素的包装。注意只读代理包 reactive 时的双层保留，与 reactiveReadArray
  // 保持一致，否则同一个元素在不同方法里身份不同。
  if (isReadonly(target)) {
    return isReactive(target) ? toReadonly(toReactive(item)) : toReadonly(item)
  }
  return toReactive(item)
}

// __proto__: null 很重要：把改写表做成没有原型的字典，避免数组方法名与
// Object.prototype 上的键冲突（也避免 `constructor` 之类的意外命中）。
export const arrayInstrumentations: Record<string | symbol, Function> = <any>{
  __proto__: null,

  [Symbol.iterator]() {
    return iterator(this, Symbol.iterator, item => toWrapped(this, item))
  },

  concat(...args: unknown[]) {
    // 参数里可能还有代理数组，逐个 reactiveReadArray 后再拼，保证结果元素是
    // 代理；非数组参数原样透传。
    return reactiveReadArray(this).concat(
      ...args.map(x => (isArray(x) ? reactiveReadArray(x) : x)),
    )
  },

  entries() {
    return iterator(this, 'entries', (value: [number, unknown]) => {
      // entries 产出 [index, value]，只包装 value。
      value[1] = toWrapped(this, value[1])
      return value
    })
  },

  every(
    fn: (item: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    // 从这里到 some()，所有“遍历 + 回调”方法都收敛到 apply()：
    // 它负责 track、把元素包装成代理、并把 3 参回调里的 array 换成代理自身。
    return apply(this, 'every', fn, thisArg, undefined, arguments)
  },

  filter(
    fn: (item: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    return apply(
      this,
      'filter',
      fn,
      thisArg,
      v => v.map((item: unknown) => toWrapped(this, item)),
      arguments,
    )
  },

  find(
    fn: (item: unknown, index: number, array: unknown[]) => boolean,
    thisArg?: unknown,
  ) {
    return apply(
      this,
      'find',
      fn,
      thisArg,
      item => toWrapped(this, item),
      arguments,
    )
  },

  findIndex(
    fn: (item: unknown, index: number, array: unknown[]) => boolean,
    thisArg?: unknown,
  ) {
    return apply(this, 'findIndex', fn, thisArg, undefined, arguments)
  },

  findLast(
    fn: (item: unknown, index: number, array: unknown[]) => boolean,
    thisArg?: unknown,
  ) {
    return apply(
      this,
      'findLast',
      fn,
      thisArg,
      item => toWrapped(this, item),
      arguments,
    )
  },

  findLastIndex(
    fn: (item: unknown, index: number, array: unknown[]) => boolean,
    thisArg?: unknown,
  ) {
    return apply(this, 'findLastIndex', fn, thisArg, undefined, arguments)
  },

  // flat, flatMap could benefit from ARRAY_ITERATE but are not straight-forward to implement

  forEach(
    fn: (item: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    return apply(this, 'forEach', fn, thisArg, undefined, arguments)
  },

  includes(...args: unknown[]) {
    // 身份敏感三兄弟（includes/indexOf/lastIndexOf）走 searchProxy：用户很
    // 可能用“代理元素”去查，而数组里存的是原始元素，需要二次尝试。
    return searchProxy(this, 'includes', args)
  },

  indexOf(...args: unknown[]) {
    return searchProxy(this, 'indexOf', args)
  },

  join(separator?: string) {
    // join 会把每个元素转字符串，必须读整表，因此同样走 reactiveReadArray。
    return reactiveReadArray(this).join(separator)
  },

  // keys() iterator only reads `length`, no optimization required
  // 注意 keys() 没有改写：它只产出下标，原生实现只读 length，而 length 的
  // 依赖已经由 baseHandlers 的 ownKeys / length 读取覆盖。

  lastIndexOf(...args: unknown[]) {
    return searchProxy(this, 'lastIndexOf', args)
  },

  map(
    fn: (item: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    // 返回值本身就是新数组，不需要 wrappedRetFn；apply 内部只负责包装入参。
    return apply(this, 'map', fn, thisArg, undefined, arguments)
  },

  pop() {
    // 变更型：会读并改写 length，必须暂停收集 + 批量触发。
    return noTracking(this, 'pop')
  },

  push(...args: unknown[]) {
    return noTracking(this, 'push', args)
  },

  reduce(
    fn: (
      acc: unknown,
      item: unknown,
      index: number,
      array: unknown[],
    ) => unknown,
    ...args: unknown[]
  ) {
    // reduce 的累加器语义需要单独处理初始值，不能复用 apply。
    return reduce(this, 'reduce', fn, args)
  },

  reduceRight(
    fn: (
      acc: unknown,
      item: unknown,
      index: number,
      array: unknown[],
    ) => unknown,
    ...args: unknown[]
  ) {
    return reduce(this, 'reduceRight', fn, args)
  },

  shift() {
    return noTracking(this, 'shift')
  },

  // slice could use ARRAY_ITERATE but also seems to beg for range tracking
  // 注释保留自上游：slice 若走 ARRAY_ITERATE，会因“任意下标变化”就重跑，粒度
  // 太粗；理想方案是范围依赖，但成本不划算，所以维持原生行为（不解包元素）。

  some(
    fn: (item: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    return apply(this, 'some', fn, thisArg, undefined, arguments)
  },

  splice(...args: unknown[]) {
    return noTracking(this, 'splice', args)
  },

  toReversed() {
    // @ts-expect-error user code may run in es2016+
    return reactiveReadArray(this).toReversed()
  },

  toSorted(comparer?: (a: unknown, b: unknown) => number) {
    // @ts-expect-error user code may run in es2016+
    return reactiveReadArray(this).toSorted(comparer)
  },

  toSpliced(...args: unknown[]) {
    // @ts-expect-error user code may run in es2016+
    return (reactiveReadArray(this).toSpliced as any)(...args)
  },

  unshift(...args: unknown[]) {
    return noTracking(this, 'unshift', args)
  },

  values() {
    return iterator(this, 'values', item => toWrapped(this, item))
  },
}

// instrument iterators to take ARRAY_ITERATE dependency
function iterator(
  self: unknown[],
  method: keyof Array<unknown>,
  wrapValue: (value: any) => unknown,
) {
  // note that taking ARRAY_ITERATE dependency here is not strictly equivalent
  // to calling iterate on the proxied array.
  // creating the iterator does not access any array property:
  // it is only when .next() is called that length and indexes are accessed.
  // pushed to the extreme, an iterator could be created in one effect scope,
  // partially iterated in another, then iterated more in yet another.
  // given that JS iterator can only be read once, this doesn't seem like
  // a plausible use-case, so this tracking simplification seems ok.
  // 中文要点：依赖在“创建迭代器”时就登记（而不是每次 next 时），是刻意的简化；
  // 迭代器只能消费一次，跨 effect 分段消费的场景可以忽略。
  const arr = shallowReadArray(self)
  const methodFn = arr[method] as any
  const iter = methodFn.call(arr) as IterableIterator<unknown> & {
    _next: IterableIterator<unknown>['next']
  }
  // arr === self 说明本来就没有代理层（原始/浅数组），不需要包装，直接返回。
  if (arr !== self && !isShallow(self)) {
    // #15643 an own `next` on a native array iterator permanently disables
    // V8's array iteration fast paths (spread, Array.from, etc.) for the whole
    // isolate, so it is wrapped instead. Checked on the iterator itself as
    // user-extended or cross-realm arrays can return native iterators too.
    // 关键取舍：不给原生迭代器实例直接挂 next（那会永久拖慢整个 isolate 的
    // 数组迭代快路径），而是用 Object.create 复制一层再覆盖 next。
    if ((iter as any)[Symbol.toStringTag] === 'Array Iterator') {
      const wrapped = Object.create(Object.getPrototypeOf(iter))
      wrapped.next = () => wrapResult(iter.next(), wrapValue)
      // 用户扩展数组的迭代器可能还有 return/throw（提前退出、异常路径），
      // 原样转发并绑定到内层迭代器。
      if (methodFn !== arrayProto[method]) {
        Object.defineProperties(wrapped, {
          return: {
            get() {
              const fn = iter.return
              return typeof fn === 'function' ? fn.bind(iter) : fn
            },
          },
          throw: {
            get() {
              const fn = iter.throw
              return typeof fn === 'function' ? fn.bind(iter) : fn
            },
          },
        })
      }
      return wrapped
    }
    // 非原生迭代器（自定义/跨 realm）：可以直接改 next，影响范围仅此实例。
    iter._next = iter.next
    iter.next = () => wrapResult(iter._next(), wrapValue)
  }
  return iter
}

function wrapResult(
  result: IteratorResult<unknown>,
  wrapValue: (value: any) => unknown,
) {
  if (!result.done) {
    result.value = wrapValue(result.value)
  }
  return result
}

// in the codebase we enforce es2016, but user code may run in environments
// higher than that
type ArrayMethods = keyof Array<any> | 'findLast' | 'findLastIndex'

const arrayProto = Array.prototype
// instrument functions that read (potentially) all items
// to take ARRAY_ITERATE dependency
function apply(
  self: unknown[],
  method: ArrayMethods,
  fn: (item: unknown, index: number, array: unknown[]) => unknown,
  thisArg?: unknown,
  wrappedRetFn?: (result: any) => unknown,
  args?: IArguments,
) {
  const arr = shallowReadArray(self)
  // 只有“代理且非浅”才需要包元素；原始数组/浅数组直接跑原生方法。
  const needsWrap = arr !== self && !isShallow(self)
  // @ts-expect-error our code is limited to es2016 but user code is not
  const methodFn = arr[method]

  // #11759
  // If the method being called is from a user-extended Array, the arguments will be unknown
  // (unknown order and unknown parameter types). In this case, we skip the shallowReadArray
  // handling and directly call apply with self.
  // 用户子类覆盖了同名方法时，参数契约未知，不能套我们的包装，原样透传。
  if (methodFn !== arrayProto[method as any]) {
    const result = methodFn.apply(self, args)
    return needsWrap ? toReactive(result) : result
  }

  let wrappedFn = fn
  if (arr !== self) {
    if (needsWrap) {
      // 包装回调：元素换成代理，第三个参数（array）换成代理自身，这样回调里
      // 继续操作数组会继续收集依赖。
      wrappedFn = function (this: unknown, item, index) {
        return fn.call(this, toWrapped(self, item), index, self)
      }
    } else if (fn.length > 2) {
      // 浅/原始数组不需要包元素，但三参回调的 array 参数仍应收到原始 self
      // （通常与 arr 相同，这里只是保证 this 语义一致）。
      wrappedFn = function (this: unknown, item, index) {
        return fn.call(this, item, index, self)
      }
    }
  }
  // 在原始数组上调用：原生实现内部读的是 arr，不会走代理陷阱，因此不会产生
  // 逐下标依赖（依赖已由 shallowReadArray 的 ARRAY_ITERATE 覆盖）。
  const result = methodFn.call(arr, wrappedFn, thisArg)
  return needsWrap && wrappedRetFn ? wrappedRetFn(result) : result
}

// instrument reduce and reduceRight to take ARRAY_ITERATE dependency
function reduce(
  self: unknown[],
  method: keyof Array<any>,
  fn: (acc: unknown, item: unknown, index: number, array: unknown[]) => unknown,
  args: unknown[],
) {
  const arr = shallowReadArray(self)
  const needsWrap = arr !== self && !isShallow(self)
  let wrappedFn = fn
  let wrapInitialAccumulator = false
  if (arr !== self) {
    if (needsWrap) {
      // reduce 没有第二个参数时，第一个元素会被当作初始累加器——它来自原始
      // 数组，也得包装；只在第一次回调时处理，之后累加器由用户/回调产生。
      wrapInitialAccumulator = args.length === 0
      wrappedFn = function (this: unknown, acc, item, index) {
        if (wrapInitialAccumulator) {
          wrapInitialAccumulator = false
          acc = toWrapped(self, acc)
        }
        return fn.call(this, acc, toWrapped(self, item), index, self)
      }
    } else if (fn.length > 3) {
      // 四参回调的 array 参数需要是代理/浅代理自身。
      wrappedFn = function (this: unknown, acc, item, index) {
        return fn.call(this, acc, item, index, self)
      }
    }
  }
  const result = (arr[method] as any)(wrappedFn, ...args)
  // 若整轮只有一个元素且没传初始值，reduce 直接返回该元素、根本没进回调，
  // 上面的 wrapInitialAccumulator 不会被消费，这里补一次包装。
  return wrapInitialAccumulator ? toWrapped(self, result) : result
}

// instrument identity-sensitive methods to account for reactive proxies
function searchProxy(
  self: unknown[],
  method: keyof Array<any>,
  args: unknown[],
) {
  // 用原始数组跑：一来避免代理层的身份差异，二来原生方法内部的下标读不该
  // 产生依赖。整表查找只建一条 ARRAY_ITERATE 依赖。
  const arr = toRaw(self) as any
  track(arr, TrackOpTypes.ITERATE, ARRAY_ITERATE_KEY)
  // we run the method using the original args first (which may be reactive)
  // 先用调用方给的参数（往往是代理）查：若数组里存的也是代理，直接命中。
  const res = arr[method](...args)

  // if that didn't work, run it again using raw values.
  // 没命中且参数是代理：换成原始值再查一次。仅重试一次，且不修改 length 等
  // 其他参数，保持与原生一致。
  if ((res === -1 || res === false) && isProxy(args[0])) {
    args[0] = toRaw(args[0])
    return arr[method](...args)
  }

  return res
}

// instrument length-altering mutation methods to avoid length being tracked
// which leads to infinite loops in some cases (#2137)
function noTracking(
  self: unknown[],
  method: keyof Array<any>,
  args: unknown[] = [],
) {
  // 三层配合：
  //   pauseTracking —— 不让内部对 length / 下标的读变成当前 effect 的依赖；
  //   startBatch/endBatch —— 一次 push 会引发多处 set/trigger，合并成一批；
  //   toRaw(self) —— 取到的原生方法直接操作原始数组，避免逐次经过代理。
  // 但 `.apply(self, args)` 的 this 仍是代理，所以写入会经过 setter 触发更新。
  pauseTracking()
  startBatch()
  const res = (toRaw(self) as any)[method].apply(self, args)
  endBatch()
  resetTracking()
  return res
}
