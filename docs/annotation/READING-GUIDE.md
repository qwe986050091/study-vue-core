# Vue 3 响应式系统阅读指南

本仓是 [vuejs/core](https://github.com/vuejs/core)（v3.5.x）的中文深度注释版。注释直接写在源码里，本文只负责回答三个问题：从哪开始、按什么顺序走、哪些可以跳过。

> 注释约定：源码里原有的英文注释全部保留；新增的中文注释以 `// =====` 文件头、`//` 段落说明和行内注释三种形式出现。所有“谁调用了谁”的说法都以当前版本的调用点为准（见文末《断言与调用点对照》）。

---

## 0. 前置知识

不需要先精通 Vue，但下面六项如果完全不熟，读注释会频繁卡住：

| 主题 | 需要到什么程度 | 在何处用到 |
| --- | --- | --- |
| `Proxy` / `Reflect` | 知道 get/set/has/ownKeys/deleteProperty 陷阱，知道 receiver 的作用 | `baseHandlers.ts`、`collectionHandlers.ts` |
| `WeakMap` / `Map` | 知道 WeakMap 的键必须是对象、不阻止 GC | `targetMap`、四种代理缓存 |
| 双向链表 | 能在纸上画出 prev/next 摘链、插尾 | `dep.ts` 的 `Link` |
| 位运算 | `x & flag`、`x |= flag`、`x &= ~flag` | `EffectFlags`、`SchedulerJobFlags` |
| 微任务 | 知道 `Promise.resolve().then` 与 `nextTick` 的关系 | `scheduler.ts` |
| 惰性求值 | 理解“没人读就不算” | `computed.ts`、`refreshComputed` |

不需要的前置：TypeScript 类型体操、构建工具、编译器（`@vue/compiler-*`）。本仓注释不依赖它们。

---

## 1. 从哪个文件开始读

**从 [`packages/reactivity/src/dep.ts`](../packages/reactivity/src/dep.ts) 开始，而不是 `reactive.ts`。**

最容易想到的入口是 `reactive.ts`：它导出 `reactive()`，名字最像“响应式系统的入口”。但它是**代理工厂**，只回答“怎么把一个对象包成 Proxy、包成哪一种、缓存在哪”。读完它你会以为响应式就是 Proxy，然后卡在下一个问题：“读一次属性之后，这个读被记到哪了？”——答案不在 `reactive.ts`，它的 get 陷阱只做了一件事：把控制权交给 `track()`。

真正的起点是 `dep.ts`，因为响应式系统的核心是一本**依赖账本**：

```
targetMap : WeakMap<对象, Map<键, Dep>>   谁被读过
Dep       : 一个键一份，记录“谁在订阅我”
Link      : 一条边，同时挂在两张双向链表上
```

把这三层看明白，后面所有文件都只是“往账本里写”或“从账本里查”。`dep.ts` 的文件头也写了同样的三层结构，可以先读那 30 行再往下。

顺带说三个也不适合当起点的文件：

- `index.ts`：纯再导出，没有逻辑；
- `effect.ts`：是执行流的核心，但它默认你已经知道 `Dep` 和 `Link` 是什么；
- `computed.ts`：它是 `effect.ts` 的消费者，先读会看到一堆 `refreshComputed` 的调用而无处落脚。

---

## 2. 主线路线（第一遍，约 5 段）

每段给出**先读的函数**和**读完应该能回答的问题**。行号对应当前注释版。

### 段 1：账本（`dep.ts`）

- `Link`（:70）：一条边为什么能同时属于两张链表；`version` 的三个时刻。
- `Dep`（:108）：`subs` 为什么只存尾指针；`activeLink` 是什么；`sc` 与链表长度为什么不是一回事。
- `Dep.track()`（:164）：新建 vs 复用 vs 同轮重复读三条分支，去重发生在哪。
- `Dep.notify()`（:246）与 `addSub()`（:287）：为什么从尾往头遍历；computed 的懒订阅。
- 模块级 `track()`（:359）与 `trigger()`（:398）：两级 Map 查找、数组 length、三个伪键的分工。

读完应能回答：**“effect 读 obj.a 两次，Dep 里有几条 Link？”**（一条；同轮重复读走第三条分支。）**“obj.a 被删掉后 Link 还在吗？”**（跑完 cleanupDeps 后被摘掉；若订阅者清零，Dep 也会从属性表删除。）

### 段 2：订阅者（`effect.ts`）

- `EffectFlags`（:71）：八个标志位逐一对应什么行为。
- `ReactiveEffect.run()`（:206）：`cleanupEffect → prepareDeps → 切 activeSub → fn → cleanupDeps` 的顺序，以及为什么放在 finally。
- `notify()`（:190）与 `trigger()`（:260）：RUNNING 自触发拦截、PAUSED 暂存、scheduler 分派。
- `batch/startBatch/endBatch`（:315–:383）：两个待执行链表、LIFO 与“尾→头”如何互相抵消、为什么 computed 只清标志不执行。
- `prepareDeps/cleanupDeps`（:385–:429）：-1 标记如何同时承担“脏检查”和“依赖淘汰”。
- `isDirty()`（:431）与 `refreshComputed()`（:458）：三级快路径。

读完应能回答：**“一次写入触发了同一个 effect 三次，它会跑几次？”**（一次；NOTIFIED 去重。）**“effect 里删掉一个分支后，旧依赖怎么消失？”**（本轮没读到 → version 仍是 -1 → cleanupDeps 摘链。）

### 段 3：读写的落点（`baseHandlers.ts` → `reactive.ts`）

- `BaseReactiveHandler.get`（`baseHandlers.ts`:78）：拦截标记 → 数组方法 → `Reflect.get` → 过滤不可追踪键 → `track` → ref 解包 → 嵌套对象转代理。这是全仓最值得逐行读的函数。
- `MutableReactiveHandler.set`（:187）：为什么先读原始 `target[key]`、`hadKey` 怎么判、`target === toRaw(receiver)` 在防什么、`hasChanged` 为什么是触发前的最后一道闸。
- `deleteProperty/has/ownKeys`（:250–:288）：DELETE、HAS、ITERATE 三种操作类型分别从哪来。
- 再回到 `reactive.ts`：`createReactiveObject`（:293）的五道拦截、四张缓存表、`TargetType` 三档。

读完应能回答：**“为什么给对象赋相同的值不触发更新？”**（`hasChanged` 不成立。）**“为什么 readonly(reactive(obj)) 的读仍然响应式？”**（readonly 层的 `Reflect.get` 穿透到内层 reactive 代理，由内层 track。）

### 段 4：惰性派生（`computed.ts`）

- `ComputedRefImpl`（:69）：它同时是 Subscriber 和依赖源（自己持有一个 `Dep`）。
- `notify()`（:144）：只置 DIRTY + 入队，返回 `true` 让上游顺手通知自己的下游。
- `get value()`（:163）：先 track 再 refresh，最后同步 link 版本。
- 回到 `effect.ts` 的 `refreshComputed`（:458）对照读：三层快路径、`dep.version++` 只在值变化时发生。

读完应能回答：**“computed 没人读时会不会重算？”**（不会；`endBatch` 只清 NOTIFIED。）**“上游变了但 computed 输出没变，下游会跑吗？”**（不会；版本号没自增。）

### 段 5：接到渲染上（`runtime-core`）

只读三个衔接点，不需要通读 `renderer.ts`：

1. `packages/runtime-core/src/renderer.ts:1362`：`componentUpdateFn` —— 渲染 effect 的函数体，mount / update 两个分支。
2. `renderer.ts:1657` 附近：`new ReactiveEffect(componentUpdateFn)` + `effect.scheduler = () => queueJob(job)`。这是 reactivity 的 `scheduler()` 唯一的落点。
3. `packages/runtime-core/src/scheduler.ts`：`queueJob`（:140）→ `flushJobs`（:339）→ `flushPostFlushCbs`（:240），以及 `nextTick`（:97）。

把这条链背下来，整个系统就闭环了：

```
读属性 → track() → Dep/Link
改属性 → trigger() → Dep.notify() → effect.trigger() → scheduler()
       → queueJob() → 微任务 flushJobs() → componentUpdateFn() → patch()
```

---

## 3. 分支主题：从哪跳进去

主线读完后再按需展开，每条分支都标了入口。

| 主题 | 入口 | 说明 |
| --- | --- | --- |
| Map / Set 响应式 | `collectionHandlers.ts:342` `createInstrumentationGetter` | 为什么集合只拦一个 `get`；`get/set/has/forEach` 的键归一化 |
| 集合迭代器 | `collectionHandlers.ts:57` `createIterableMethod` | `Object.create(innerIterator)` 只覆盖 `next`；`MAP_KEY_ITERATE_KEY` 与 `ITERATE_KEY` 的区别 |
| 数组方法改写 | `arrayInstrumentations.ts:85` | 四条策略：`reactiveReadArray` / `iterator` / `apply` / `searchProxy` / `noTracking` |
| 数组迭代为何只用一条依赖 | `arrayInstrumentations.ts:42`、`dep.ts` 中 `ARRAY_ITERATE_KEY` | 任意下标写入都会通知它；`length` 单独处理 |
| ref 与解包 | `ref.ts:131` `RefImpl`、`ref.ts:280` `proxyRefs` | `_rawValue` / `_value` 双份存储；数组下标不解包 |
| toRef / toRefs | `ref.ts:406` `ObjectRefImpl` | 没有自己的 Dep，`dep` getter 从 `targetMap` 反查 |
| 手动挡 ref | `ref.ts:322` `CustomRefImpl` | 把 `dep.track` / `dep.trigger` 直接交给用户 |
| watch / watchEffect | `watch.ts:145` | 源归一化 → job → 调度器；`deep` 最终落在 `traverse`（:401） |
| watch 的调度默认值 | `runtime-core/src/apiWatch.ts:210` | 公开 API 的 `flush: 'pre'` 在这里注入 `queueJob`；`reactivity` 的 base `watch` 不传 scheduler 时是同步的 |
| effect 分组生命周期 | `effectScope.ts:22` | `detached` 组件 scope、`on/off` 计数、`stop` 的 O(1) 摘除 |
| 组件更新队列 | `scheduler.ts:140` | id 排序、pre 插队、post 阶段、递归上限 |
| 组件 scope | `runtime-core/src/component.ts:640` | 为什么组件 scope 是 detached |

---

## 4. 可以跳过的部分

第一遍读主线时，下面这些可以整段跳过，不影响理解：

1. **`reactive.ts` 的类型定义段**（`DeepReadonly`、`UnwrapNestedRefs` 等，约 :500 之后）：纯类型体操，运行时为零。
2. **所有 `__DEV__` 分支**：只在开发构建存在。读的时候可以只看 `else`/跳过，但注意有两处 DEV 分支承载了真实语义差异——`Dep.notify()` 里的 `onTrigger` 顺序、`scheduler` 里 `checkRecursiveUpdates` 的裁剪（注释里已标出）。
3. **`__COMPAT__` / `__FEATURE_*__` 分支**：兼容层与可选特性，不属于响应式主线。
4. **`index.ts`、`warning.ts`**：无逻辑。`index.ts` 的注释只用于导航。
5. **SSR 相关分支**：`refreshComputed` 里的 `isSSR` 一段可以最后再看，它解释的是“没有下游订阅者时怎么缓存”。
6. **`renderer.ts` 除 1349–1690 之外的代码**：diff/patch/挂载卸载属于渲染器主题，与响应式只在 `componentUpdateFn` 与 `queueJob` 两处相交。
7. **`errorHandling.ts`、`devtools` 调用**：错误边界与调试面板，不影响依赖图。

---

## 5. 三个自测问题（能答上就算读懂主线）

1. `effect(() => obj.a)` 执行两次，第二次 `obj.a` 没变。这两次之间 `Link.version`、`Dep.version`、`globalVersion` 各发生了什么？为什么第二次不重复创建 Link？
2. `computed` 的下游 effect 正在执行时，上游改了值。此时谁会立刻执行、谁只被标脏？`endBatch` 对 computed 和 effect 的处理差在哪？
3. 数组 `push` 一个元素，会依次触发哪些 Dep？`push` 内部读 `length` 为什么不会让当前 effect 依赖 `length`？

---

## 6. 断言与调用点对照

注释里凡是“谁在用它”的断言，都按当前版本核对过调用点。集中列在这里，便于复查：

| 断言 | 调用点 |
| --- | --- |
| 组件渲染 effect 的 scheduler 是 `queueJob` | `runtime-core/src/renderer.ts:1671` |
| 公开 `watch` 的默认 pre 调度来自 runtime-core | `runtime-core/src/apiWatch.ts:201-226` |
| 组件 scope 是 detached | `runtime-core/src/component.ts:640` |
| `shallowReadonly` 用于 DEV 下的 props/attrs/slots 只读视图 | `runtime-core/src/componentPublicInstance.ts:408-411`、`component.ts:885` |
| `instance.props` 用的是 `shallowReactive` | `runtime-core/src/componentProps.ts:226` |
| `getDepFromReactive` 供 `ObjectRefImpl.dep` 反查 | `ref.ts:463` |
| `ARRAY_ITERATE_KEY` 由数组下标写入触发 | `dep.ts` `trigger()` 的 `isArrayIndex` 分支 |
