// @vue/reactivity 的公共出口。读源码时不必按这里的顺序读：它只是把各文件
// 的导出重新汇集，没有逻辑。
//
// 想理解响应式链路，按依赖顺序读：
//   constants.ts → dep.ts → effect.ts → reactive.ts/baseHandlers.ts
//   → ref.ts / computed.ts → collectionHandlers.ts / arrayInstrumentations.ts
//   → watch.ts / effectScope.ts
// ref 家族：单值容器与解包工具。
export {
  ref,
  shallowRef,
  isRef,
  toRef,
  toValue,
  toRefs,
  unref,
  proxyRefs,
  customRef,
  triggerRef,
  type Ref,
  type MaybeRef,
  type MaybeRefOrGetter,
  type ToRef,
  type ToRefs,
  type UnwrapRef,
  type ShallowRef,
  type ShallowUnwrapRef,
  type RefUnwrapBailTypes,
  type CustomRefFactory,
} from './ref'
// reactive 家族：代理工厂、风味判断、toRaw / markRaw。
export {
  reactive,
  readonly,
  isReactive,
  isReadonly,
  isShallow,
  isProxy,
  shallowReactive,
  shallowReadonly,
  markRaw,
  toRaw,
  toReactive,
  toReadonly,
  type Raw,
  type DeepReadonly,
  type ShallowReactive,
  type UnwrapNestedRefs,
  type Reactive,
  type ReactiveMarker,
} from './reactive'
// computed：惰性派生值。
export {
  computed,
  type ComputedRef,
  type WritableComputedRef,
  type WritableComputedOptions,
  type ComputedGetter,
  type ComputedSetter,
  type ComputedRefImpl,
} from './computed'
// effect 与依赖收集的原语（track/trigger/伪键）。
export {
  effect,
  stop,
  enableTracking,
  pauseTracking,
  resetTracking,
  onEffectCleanup,
  ReactiveEffect,
  EffectFlags,
  type ReactiveEffectRunner,
  type ReactiveEffectOptions,
  type EffectScheduler,
  type DebuggerOptions,
  type DebuggerEvent,
  type DebuggerEventExtraInfo,
} from './effect'
export {
  trigger,
  track,
  ITERATE_KEY,
  ARRAY_ITERATE_KEY,
  MAP_KEY_ITERATE_KEY,
} from './dep'
// 分组生命周期与数组读取辅助（后者主要给 runtime-core / 编译产物用）。
export {
  effectScope,
  EffectScope,
  getCurrentScope,
  onScopeDispose,
} from './effectScope'
export { reactiveReadArray, shallowReadArray } from './arrayInstrumentations'
export { TrackOpTypes, TriggerOpTypes, ReactiveFlags } from './constants'
// watch 家族：依赖变化后的回调/副作用。
export {
  watch,
  getCurrentWatcher,
  traverse,
  onWatcherCleanup,
  WatchErrorCodes,
  type WatchOptions,
  type WatchScheduler,
  type WatchStopHandle,
  type WatchHandle,
  type WatchEffect,
  type WatchSource,
  type WatchCallback,
  type OnCleanup,
} from './watch'
