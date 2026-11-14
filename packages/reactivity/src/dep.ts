// ============================================================================
// dep.ts：依赖关系的存储层（响应式系统的“账本”）
// ============================================================================
// 读这个文件只需要抓住一个问题：一次属性读取（track）如何被记住，一次属性写入
// （trigger）又如何找到所有该重跑的订阅者。
//
// 三层结构：
//   targetMap : WeakMap<目标对象, Map<属性键, Dep>>   —— 谁被读过
//   Dep       : 一个属性键对应一份，记录“哪些订阅者依赖我” —— 谁在读我
//   Link      : 一条边，同时挂在两张双向链表上            —— 订阅关系本身
//
// 为什么是一条边挂两张链表，而不是 Dep 里放 Map<Subscriber, count> / Set：
//   1. 一个 Subscriber（effect 或 computed）有多个依赖，一个 Dep 有多个订阅者，
//      关系是多对多，天然需要边对象来承载“版本号”这种每条边各自的状态；
//   2. 重跑 effect 时要能低成本地淘汰“这次没读到的依赖”：Link.version 置 -1，
//      跑完扫一遍链表即可，不需要重建整个 Set；
//   3. 删除是 O(1)：持有 prev/next 指针，直接摘链；Set 删除后还要考虑遍历顺序
//      与迭代期间的修改；
//   4. 一条 Link 只分配一次，后续重跑复用（Dep.activeLink 快路径），避免每次
//      track 都产生新对象。
// 代价是没有 Set 的自动去重：去重靠“每个 Dep 记录当前 activeLink，且其 sub 必须
// 是 activeSub”来判断，见 Dep.track()。
//
// 与 MobX 的取舍差别（只提一句）：MobX 走手动依赖收集（observable 自己维护
// observers 集合，reaction 主动上报），Vue 走 Proxy 拦截 + 全局 activeSub 栈，
// 因此这里才有“当前活跃订阅者”这样的隐式上下文。
// ============================================================================

import { extend, isArray, isIntegerKey, isMap, isSymbol } from '@vue/shared'
import type { ComputedRefImpl } from './computed'
import { type TrackOpTypes, TriggerOpTypes } from './constants'
import {
  type DebuggerEventExtraInfo,
  EffectFlags,
  type Subscriber,
  activeSub,
  endBatch,
  shouldTrack,
  startBatch,
} from './effect'

/**
 * Incremented every time a reactive change happens
 * This is used to give computed a fast path to avoid re-compute when nothing
 * has changed.
 */
// 全局单调递增的“世界版本号”。任何一次 Dep.trigger 都会 ++，computed 在
// refreshComputed() 里先比对自己缓存的 globalVersion：相等说明从上次求值到现在
// 整个响应式世界都没变过，直接返回缓存值。注意它只增不减，也不回绕。
export let globalVersion = 0

/**
 * Represents a link between a source (Dep) and a subscriber (Effect or Computed).
 * Deps and subs have a many-to-many relationship - each link between a
 * dep and a sub is represented by a Link instance.
 *
 * A Link is also a node in two doubly-linked lists - one for the associated
 * sub to track all its deps, and one for the associated dep to track all its
 * subs.
 *
 * @internal
 */
// 一条 Link = “某个 Subscriber 依赖某个 Dep”这一事实。
// 同一个 Link 同时是两条链表的节点：
//   sub 视角：sub.deps / sub.depsTail 串起 nextDep / prevDep，按访问顺序排列；
//   dep 视角：dep.subs 是尾指针，串起 nextSub / prevSub。
// 两张链表的头尾约定不同，读的时候别混：
//   - sub 侧：deps 是头，depsTail 是尾，新依赖追加到尾；
//   - dep 侧：只存尾（subs），通知时从尾往头走（prevSub）。
export class Link {
  /**
   * - Before each effect run, all previous dep links' version are reset to -1
   * - During the run, a link's version is synced with the source dep on access
   * - After the run, links with version -1 (that were never used) are cleaned
   *   up
   */
  // 三个时刻的语义（对应 effect.run() 里的 prepareDeps / cleanupDeps）：
  //   跑之前统一置 -1 → 跑的过程中每次读到就同步成 dep.version → 跑完仍是 -1
  //   的说明本轮没读过，可以摘掉。因此它既用来做脏检查，也用来做依赖淘汰。
  version: number

  /**
   * Pointers for doubly-linked lists
   */
  nextDep?: Link
  prevDep?: Link
  nextSub?: Link
  prevSub?: Link
  prevActiveLink?: Link

  constructor(
    public sub: Subscriber,
    public dep: Dep,
  ) {
    this.version = dep.version
    this.nextDep =
      this.prevDep =
      this.nextSub =
      this.prevSub =
      this.prevActiveLink =
        undefined
  }
}

/**
 * @internal
 */
export class Dep {
  // 每触发一次自增。Link.version 复制的是“上次读到时的版本”，两者不等即代表
  // 这个依赖变了（isDirty 的判断依据）。computed 求值有变化时也会 ++，从而把
  // “computed 的值变了”传给它的下游订阅者。
  version = 0
  /**
   * Link between this dep and the current active effect
   */
  // activeLink 不是“任意一条边”，而是“上一次由 activeSub 访问时创建/复用的那
  // 条边”。effect 重跑时如果还是同一个 sub 访问同一个 dep，就能直接复用这条边，
  // 省掉一次分配和一次插入。嵌套求值（computed 里再读属性）会覆盖它，所以
  // prepareDeps 要把它存进 link.prevActiveLink，跑完再还原。
  activeLink?: Link = undefined

  /**
   * Doubly linked list representing the subscribing effects (tail)
   */
  // dep 侧链表只保留尾指针 subs。新订阅者接在尾部，通知时从尾部往前遍历
  // （见 notify()），这样在 batch 里“后进先出”的压栈顺序刚好被反向抵消。
  subs?: Link = undefined

  /**
   * Doubly linked list representing the subscribing effects (head)
   * DEV only, for invoking onTrigger hooks in correct order
   */
  // DEV 才维护头指针，唯一用途是让 onTrigger 调试钩子按订阅的原始顺序触发；
  // 生产构建里连这个字段都不存在（见下端 constructor 的 __DEV__ 分支）。
  subsHead?: Link

  /**
   * For object property deps cleanup
   */
  // map / key 指回自己在 targetMap 里的位置，使 Dep 能在“订阅者清零”时把自己
  // 从 Map 里删掉（removeSub 里的 dep.map.delete(dep.key)，对应 issue #11979）。
  map?: KeyToDepMap = undefined
  key?: unknown = undefined

  /**
   * Subscriber counter
   */
  // 订阅者计数。软退订（soft）不减它，所以它回答的是“还有没有真实订阅者”，
  // 而不是“链表里挂了几条边”——computed 可能保留 link 但已不参与订阅。
  sc: number = 0

  /**
   * @internal
   */
  readonly __v_skip = true
  // TODO isolatedDeclarations ReactiveFlags.SKIP

  constructor(public computed?: ComputedRefImpl | undefined) {
    if (__DEV__) {
      this.subsHead = undefined
    }
  }

  track(debugInfo?: DebuggerEventExtraInfo): Link | undefined {
    // 三种情况不记依赖：
    //   - 没有活跃订阅者（普通代码在跑，不是 effect/computed 内部）；
    //   - 全局暂停了收集（pauseTracking，数组变更方法与 watch 回调里用）；
    //   - 是 computed 在读自己的 dep（自指，记了就是无限递归）。
    if (!activeSub || !shouldTrack || activeSub === this.computed) {
      return
    }

    let link = this.activeLink
    // 快路径失败有两种可能：这个 dep 从没被访问过，或者上次访问它的不是当前
    // 订阅者（典型场景：同一个属性先被父 effect 读、又被内层 computed 读）。
    // 两种都只能新建一条边；旧边仍留在原订阅者的链表里，不受影响。
    if (link === undefined || link.sub !== activeSub) {
      link = this.activeLink = new Link(activeSub, this)

      // add the link to the activeEffect as a dep (as tail)
      // 接到订阅者依赖链表的尾部：顺序 = 本次访问顺序，便于之后把“本轮也访问
      // 过”的旧边移动到尾部（下面的复用分支），从而保持链表顺序与访问顺序一致。
      if (!activeSub.deps) {
        activeSub.deps = activeSub.depsTail = link
      } else {
        link.prevDep = activeSub.depsTail
        activeSub.depsTail!.nextDep = link
        activeSub.depsTail = link
      }

      addSub(link)
    } else if (link.version === -1) {
      // reused from last run - already a sub, just sync version
      // 走到这里说明本轮 prepareDeps 已经把它置 -1，现在重新读到了：同步版本
      // 即视为“本轮仍在使用”，cleanupDeps 就不会摘它。
      link.version = this.version

      // If this dep has a next, it means it's not at the tail - move it to the
      // tail. This ensures the effect's dep list is in the order they are
      // accessed during evaluation.
      // 复用分支不需要重做 addSub：dep 侧的订阅关系还在，只是顺序可能变了。
      if (link.nextDep) {
        const next = link.nextDep
        next.prevDep = link.prevDep
        if (link.prevDep) {
          link.prevDep.nextDep = next
        }

        link.prevDep = activeSub.depsTail
        link.nextDep = undefined
        activeSub.depsTail!.nextDep = link
        activeSub.depsTail = link

        // this was the head - point to the new head
        if (activeSub.deps === link) {
          activeSub.deps = next
        }
      }
    }
    // 第三种情况：link.sub === activeSub 且 version !== -1，说明本轮已经读过
    // 这个 dep（同一轮内重复读同一属性），什么都不用做——这就是去重的落点。

    if (__DEV__ && activeSub.onTrack) {
      activeSub.onTrack(
        extend(
          {
            effect: activeSub,
          },
          debugInfo,
        ),
      )
    }

    return link
  }

  trigger(debugInfo?: DebuggerEventExtraInfo): void {
    // 两处自增缺一不可：
    //   dep.version 让“读过我”的订阅者在下一次 isDirty 时发现自己过期；
    //   globalVersion 让所有 computed 的全局快路径失效（哪怕它没订阅这个 dep）。
    this.version++
    globalVersion++
    this.notify(debugInfo)
  }

  notify(debugInfo?: DebuggerEventExtraInfo): void {
    // 批量窗口：窗口内只把订阅者压进待处理链表，窗口关闭时统一执行。嵌套的
    // trigger（比如 setter 里再改别的属性）靠 batchDepth 计数合并成一次。
    startBatch()
    try {
      if (__DEV__) {
        // subs are notified and batched in reverse-order and then invoked in
        // original order at the end of the batch, but onTrigger hooks should
        // be invoked in original order here.
        // DEV 下额外正向扫一遍头指针，只为让 onTrigger 按订阅顺序回调。
        for (let head = this.subsHead; head; head = head.nextSub) {
          if (head.sub.onTrigger && !(head.sub.flags & EffectFlags.NOTIFIED)) {
            head.sub.onTrigger(
              extend(
                {
                  effect: head.sub,
                },
                debugInfo,
              ),
            )
          }
        }
      }
      // 从尾部往头部走。batch() 采用头插法压栈，两次逆序抵消后，endBatch 执行
      // 顺序就回到订阅的原始顺序；这样设计的好处是不需要在 trigger 时排序。
      for (let link = this.subs; link; link = link.prevSub) {
        if (link.sub.notify()) {
          // if notify() returns `true`, this is a computed. Also call notify
          // on its dep - it's called here instead of inside computed's notify
          // in order to reduce call stack depth.
          // computed 的 notify 只标脏、不立即求值；这里直接把“值可能变了”继续
          // 传给它的下游，避免 computed -> dep -> computed 的递归调用堆栈。
          ;(link.sub as ComputedRefImpl).dep.notify()
        }
      }
    } finally {
      endBatch()
    }
  }
}

function addSub(link: Link) {
  // 先计真实订阅者数，再判断是否要真正挂到 dep 的订阅链表上：
  // TRACKING 关闭的订阅者（典型：已无下游订阅者的 computed）只保留计数与 link，
  // 不参与通知；等它重新被订阅时，addSub 会把它的依赖重新挂上（见下）。
  link.dep.sc++
  if (link.sub.flags & EffectFlags.TRACKING) {
    const computed = link.dep.computed
    // computed getting its first subscriber
    // enable tracking + lazily subscribe to all its deps
    // computed 是惰性的：求值时只记下 deps 链表，并未让这些 dep 记住自己（避免
    // 没人用也保持订阅）。第一个下游订阅者出现时，才把它的整条依赖链补登记。
    if (computed && !link.dep.subs) {
      computed.flags |= EffectFlags.TRACKING | EffectFlags.DIRTY
      for (let l = computed.deps; l; l = l.nextDep) {
        addSub(l)
      }
    }

    // 挂到 dep 订阅链表尾部；重复挂同一条 link 是幂等的（currentTail !== link）。
    const currentTail = link.dep.subs
    if (currentTail !== link) {
      link.prevSub = currentTail
      if (currentTail) currentTail.nextSub = link
    }

    if (__DEV__ && link.dep.subsHead === undefined) {
      link.dep.subsHead = link
    }

    link.dep.subs = link
  }
}


// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Maps to reduce memory overhead.
type KeyToDepMap = Map<any, Dep>
// 全局依赖表：
//   key 是原始对象（不是 Proxy）——所以 reactive 代理和它的 toRaw 共享同一份依赖；
//   WeakMap 保证目标对象被回收后整张属性表一起回收，不阻止 GC。
// 注意这里按“属性键”而不是按“对象”建 Dep：同一个对象的不同属性互不打扰。
export const targetMap: WeakMap<object, KeyToDepMap> = new WeakMap()

export const ITERATE_KEY: unique symbol = Symbol(
  __DEV__ ? 'Object iterate' : '',
)
// 三个“伪属性键”用来把整对象/集合级遍历压缩成一份 Dep，而不用给每个键都记一遍。
// 它们的区别只体现在 trigger 的开关上（见本文件末尾的 switch）：
//   ITERATE_KEY         对象 for-in / Object.keys / Map 的 values/entries / Set 遍历
//   MAP_KEY_ITERATE_KEY 仅 Map.keys()：值变（SET）不重跑，键增删才重跑
//   ARRAY_ITERATE_KEY   数组的迭代/回调方法：任意下标写入都会让它重跑
// 分开的原因：Map 的 keys() 只关心键集合，若和 values() 共用一个 Dep，改一个已有
// key 的值会让只读键的 effect 白跑一次。
export const MAP_KEY_ITERATE_KEY: unique symbol = Symbol(
  __DEV__ ? 'Map keys iterate' : '',
)
export const ARRAY_ITERATE_KEY: unique symbol = Symbol(
  __DEV__ ? 'Array iterate' : '',
)

/**
 * Tracks access to a reactive property.
 *
 * This will check which effect is running at the moment and record it as dep
 * which records all effects that depend on the reactive property.
 *
 * @param target - Object holding the reactive property.
 * @param type - Defines the type of access to the reactive property.
 * @param key - Identifier of the reactive property to track.
 */
export function track(target: object, type: TrackOpTypes, key: unknown): void {
  // 一次“读”的入口。三道闸：
  //   shouldTrack —— 全局开关，pauseTracking() 期间读属性不入账；
  //   activeSub   —— 必须有正在求值的订阅者，否则这条依赖没人消费；
  //   后面的 Dep.track() 还会排除 computed 自读。
  if (shouldTrack && activeSub) {
    // 两级 Map 查找：对象 -> 属性表 -> Dep。第一次访问某对象时懒建属性表，
    // 第一次访问某属性时懒建 Dep（Dep 本身不知道键，要把 map/key 回填给它）。
    let depsMap = targetMap.get(target)
    if (!depsMap) {
      targetMap.set(target, (depsMap = new Map()))
    }
    let dep = depsMap.get(key)
    if (!dep) {
      depsMap.set(key, (dep = new Dep()))
      dep.map = depsMap
      dep.key = key
    }
    // DEV 分支只是把 target/type/key 打包给 onTrack 调试钩子，逻辑完全相同。
    if (__DEV__) {
      dep.track({
        target,
        type,
        key,
      })
    } else {
      dep.track()
    }
  }
}

/**
 * Finds all deps associated with the target (or a specific property) and
 * triggers the effects stored within.
 *
 * @param target - The reactive object.
 * @param type - Defines the type of the operation that needs to trigger effects.
 * @param key - Can be used to target a specific reactive property in the target object.
 */
export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>,
): void {
  const depsMap = targetMap.get(target)
  if (!depsMap) {
    // never been tracked
    // 这个对象从没被读取过，自然没有订阅者。仍要推进 globalVersion，因为
    // computed 的全局快路径只看这个数，不能漏掉“无人订阅的写”。
    globalVersion++
    return
  }

  // run 是“按 Dep 触发”的薄封装，DEV 下顺带打包调试信息。
  const run = (dep: Dep | undefined) => {
    if (dep) {
      if (__DEV__) {
        dep.trigger({
          target,
          type,
          key,
          newValue,
          oldValue,
          oldTarget,
        })
      } else {
        dep.trigger()
      }
    }
  }

  // 一次写入可能波及多个 Dep（自身键 + 迭代键 + length……），用一个批量窗口
  // 把它们合并，避免同一个 effect 因多个 Dep 被连续执行多次。
  startBatch()

  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    // Map/Set 的 clear() 语义上是“所有键都变了”，因此不做键级筛选，全表通知。
    depsMap.forEach(run)
  } else {
    const targetIsArray = isArray(target)
    const isArrayIndex = targetIsArray && isIntegerKey(key)

    if (targetIsArray && key === 'length') {
      // 改 length 会隐式删掉尾部元素：只有下标 >= 新长度的 Dep 需要重跑；
      // 同时 length 自身与“数组迭代”也要重跑。
      const newLength = Number(newValue)
      depsMap.forEach((dep, key) => {
        if (
          key === 'length' ||
          key === ARRAY_ITERATE_KEY ||
          (!isSymbol(key) && key >= newLength)
        ) {
          run(dep)
        }
      })
    } else {
      // schedule runs for SET | ADD | DELETE
      // 自身键先通知；key 为 undefined 的写入（如清空操作）也走这个分支。
      if (key !== void 0 || depsMap.has(void 0)) {
        run(depsMap.get(key))
      }

      // schedule ARRAY_ITERATE for any numeric key change (length is handled above)
      // 任意数字下标的写入都视为“数组内容变了”，通知所有迭代型消费者。
      if (isArrayIndex) {
        run(depsMap.get(ARRAY_ITERATE_KEY))
      }

      // also run for iteration key on ADD | DELETE | Map.SET
      // 结构性变化（增/删）才通知整对象遍历；普通 SET 不改变键集合，所以
      // 对象 for-in 不需要重跑（Map 例外，见 case SET）。
      switch (type) {
        case TriggerOpTypes.ADD:
          if (!targetIsArray) {
            run(depsMap.get(ITERATE_KEY))
            if (isMap(target)) {
              run(depsMap.get(MAP_KEY_ITERATE_KEY))
            }
          } else if (isArrayIndex) {
            // new index added to array -> length changes
            // 数组尾部追加会同时改 length，必须补一次 length 通知。
            run(depsMap.get('length'))
          }
          break
        case TriggerOpTypes.DELETE:
          if (!targetIsArray) {
            run(depsMap.get(ITERATE_KEY))
            if (isMap(target)) {
              run(depsMap.get(MAP_KEY_ITERATE_KEY))
            }
          }
          break
        case TriggerOpTypes.SET:
          if (isMap(target)) {
            // Map 的 value 变化会影响 values()/entries() 的产出，故也要通知
            // 整表遍历；但不通知 MAP_KEY_ITERATE_KEY（键集合没变）。
            run(depsMap.get(ITERATE_KEY))
          }
          break
      }
    }
  }

  endBatch()
}

export function getDepFromReactive(
  object: any,
  key: string | number | symbol,
): Dep | undefined {
  const depMap = targetMap.get(object)
  return depMap && depMap.get(key)
}
