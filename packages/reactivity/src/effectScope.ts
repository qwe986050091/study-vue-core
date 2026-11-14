// ============================================================================
// effectScope.ts：effect 的分组生命周期
// ============================================================================
// scope 解决的问题：一个组件（或一段逻辑）里创建的 effect / computed / watch
// 需要一起停止。没有 scope 就得手动收集每个 stop 句柄；有 scope 只需 stop 一次。
//
// 结构：
//   - 非 detached scope 会挂到当前 activeEffectScope 的 scopes 数组里，形成树；
//   - 创建的 ReactiveEffect 在构造时自动 push 进当前 scope；
//   - stop() 递归停 effects、跑 cleanups、停子 scope，并从父 scope 的数组里
//     O(1) 摘除（用 index + 尾部交换，见 stop 末尾）。
//
// on()/off() 是给异步组件用的“可重入的激活”：withAsyncContext 在 await 前后
// 重新挂上/摘掉 scope，因此用计数 _on 而不是布尔。
// ============================================================================

import type { ReactiveEffect } from './effect'
import { warn } from './warning'

export let activeEffectScope: EffectScope | undefined

export class EffectScope {
  /**
   * @internal
   */
  private _active = true
  /**
   * @internal track `on` calls, allow `on` call multiple times
   */
  private _on = 0
  /**
   * @internal
   */
  effects: ReactiveEffect[] = []
  /**
   * @internal
   */
  cleanups: (() => void)[] = []

  private _isPaused = false
  private _warnOnRun = true

  /**
   * only assigned by undetached scope
   * @internal
   */
  parent: EffectScope | undefined
  /**
   * record undetached scopes
   * @internal
   */
  scopes: EffectScope[] | undefined
  /**
   * track a child scope's index in its parent's scopes array for optimized
   * removal
   * @internal
   */
  private index: number | undefined

  readonly __v_skip = true
  // TODO isolatedDeclarations ReactiveFlags.SKIP

  constructor(public detached = false) {
    // detached scope 不挂父级，生命周期完全由持有者负责（组件实例的 scope
    // 就是 detached，见 runtime-core/component.ts:640）。
    if (!detached && activeEffectScope) {
      if (activeEffectScope.active) {
        this.parent = activeEffectScope
        // index 记录自己在父数组中的位置，stop 时用于 O(1) 交换删除。
        this.index =
          (activeEffectScope.scopes || (activeEffectScope.scopes = [])).push(
            this,
          ) - 1
      } else {
        // The parent scope has already stopped, so this child must not become
        // a detached live scope.
        // 父 scope 已停止：子 scope 也不能活着，否则会变成无人管理的孤儿。
        this._active = false
        this._warnOnRun = false
      }
    }
  }

  get active(): boolean {
    return this._active
  }

  pause(): void {
    if (this._active) {
      this._isPaused = true
      let i, l
      if (this.scopes) {
        const scopes = this.scopes.slice()
        for (i = 0, l = scopes.length; i < l; i++) {
          scopes[i].pause()
        }
      }
      for (i = 0, l = this.effects.length; i < l; i++) {
        this.effects[i].pause()
      }
    }
  }

  /**
   * Resumes the effect scope, including all child scopes and effects.
   */
  resume(): void {
    if (this._active) {
      if (this._isPaused) {
        this._isPaused = false
        let i, l
        if (this.scopes) {
          const scopes = this.scopes.slice()
          for (i = 0, l = scopes.length; i < l; i++) {
            scopes[i].resume()
          }
        }
        const effects = this.effects.slice()
        for (i = 0, l = effects.length; i < l; i++) {
          effects[i].resume()
        }
      }
    }
  }

  run<T>(fn: () => T): T | undefined {
    if (this._active) {
      const currentEffectScope = activeEffectScope
      try {
        activeEffectScope = this
        return fn()
      } finally {
        activeEffectScope = currentEffectScope
      }
    } else if (__DEV__ && this._warnOnRun) {
      warn(`cannot run an inactive effect scope.`)
    }
  }

  prevScope: EffectScope | undefined
  /**
   * This should only be called on non-detached scopes
   * @internal
   */
  on(): void {
    if (++this._on === 1) {
      this.prevScope = activeEffectScope
      activeEffectScope = this
    }
  }

  /**
   * This should only be called on non-detached scopes
   * @internal
   */
  off(): void {
    if (this._on > 0 && --this._on === 0) {
      // Fast path: in the common LIFO case this scope is still at the top
      // of the active chain, so we can restore the previous scope directly.
      if (activeEffectScope === this) {
        activeEffectScope = this.prevScope
      } else {
        // withAsyncContext() restores the current component scope for the
        // current async continuation, then defers its cleanup to a microtask.
        // If sibling continuations interleave (A restore -> B restore ->
        // A cleanup), activeEffectScope is already B instead of this scope A
        // when A's cleanup calls off(). Unlink A from the middle of the
        // active chain so a stale scope doesn't remain globally reachable.
        let current = activeEffectScope
        while (current) {
          if (current.prevScope === this) {
            current.prevScope = this.prevScope
            break
          }
          current = current.prevScope
        }
      }
      this.prevScope = undefined
    }
  }

  stop(fromParent?: boolean): void {
    if (this._active) {
      this._active = false
      let i, l
      // 先停 effect：每个 effect.stop() 会做 O(依赖数) 的摘链，必须在清空数组前。
      for (i = 0, l = this.effects.length; i < l; i++) {
        this.effects[i].stop()
      }
      this.effects.length = 0

      // 再跑用户 cleanup（onScopeDispose 注册的）。
      for (i = 0, l = this.cleanups.length; i < l; i++) {
        this.cleanups[i]()
      }
      this.cleanups.length = 0

      // 递归停子 scope；传 true 表示“由父级发起”，子级不需要再回头摘自己。
      if (this.scopes) {
        const scopes = this.scopes.slice()
        for (i = 0, l = scopes.length; i < l; i++) {
          scopes[i].stop(true)
        }
        this.scopes.length = 0
      }

      // nested scope, dereference from parent to avoid memory leaks
      if (!this.detached && this.parent && !fromParent) {
        // optimized O(1) removal
        // 用“尾部元素填到我的槽位”代替 splice：不关心子 scope 顺序，换来的
        // 是 O(1)；被移动的元素要同步更新 index。
        const last = this.parent.scopes!.pop()
        if (last && last !== this) {
          this.parent.scopes![this.index!] = last
          last.index = this.index!
        }
      }
      this.parent = undefined
    }
  }
}

/**
 * Creates an effect scope object which can capture the reactive effects (i.e.
 * computed and watchers) created within it so that these effects can be
 * disposed together. For detailed use cases of this API, please consult its
 * corresponding {@link https://github.com/vuejs/rfcs/blob/master/active-rfcs/0041-reactivity-effect-scope.md | RFC}.
 *
 * @param detached - Can be used to create a "detached" effect scope.
 * @see {@link https://vuejs.org/api/reactivity-advanced.html#effectscope}
 */
export function effectScope(detached?: boolean): EffectScope {
  return new EffectScope(detached)
}

/**
 * Returns the current active effect scope if there is one.
 *
 * @see {@link https://vuejs.org/api/reactivity-advanced.html#getcurrentscope}
 */
export function getCurrentScope(): EffectScope | undefined {
  return activeEffectScope
}

/**
 * Registers a dispose callback on the current active effect scope. The
 * callback will be invoked when the associated effect scope is stopped.
 *
 * @param fn - The callback function to attach to the scope's cleanup.
 * @see {@link https://vuejs.org/api/reactivity-advanced.html#onscopedispose}
 */
export function onScopeDispose(fn: () => void, failSilently = false): void {
  if (activeEffectScope) {
    if (activeEffectScope.active) {
      activeEffectScope.cleanups.push(fn)
    } else {
      // The scope has already been stopped and will not run its cleanups
      // again, e.g. a component's async setup resumed after it was unmounted.
      fn()
    }
  } else if (__DEV__ && !failSilently) {
    warn(
      `onScopeDispose() is called when there is no active effect scope` +
        ` to be associated with.`,
    )
  }
}
