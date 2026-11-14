// ============================================================================
// constants.ts：操作类型枚举
// ============================================================================
// TrackOpTypes / TriggerOpTypes 会出现在 debugger 事件里，所以用可读字符串而
// 不是数字——断点里一眼能看出是 get 还是 iterate。
// ReactiveFlags 是代理的“内部协议键”：isReactive/toRaw/isRef 等全部靠读这些键
// 判断，因此它们必须是不能被用户数据意外命中的保留名。
// ============================================================================

// using literal strings instead of numbers so that it's easier to inspect
// debugger events

export enum TrackOpTypes {
  GET = 'get',
  HAS = 'has',
  ITERATE = 'iterate',
}

export enum TriggerOpTypes {
  SET = 'set',
  ADD = 'add',
  DELETE = 'delete',
  CLEAR = 'clear',
}

export enum ReactiveFlags {
  SKIP = '__v_skip',
  IS_REACTIVE = '__v_isReactive',
  IS_READONLY = '__v_isReadonly',
  IS_SHALLOW = '__v_isShallow',
  RAW = '__v_raw',
  IS_REF = '__v_isRef',
}
