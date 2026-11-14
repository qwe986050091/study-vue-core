// 统一警告出口。放在独立文件里是为了让各模块只依赖一个极小的模块，避免
// warning → 其他模块的循环依赖；同时便于构建时整体替换/裁剪。
export function warn(msg: string, ...args: any[]): void {
  console.warn(`[Vue warn] ${msg}`, ...args)
}
