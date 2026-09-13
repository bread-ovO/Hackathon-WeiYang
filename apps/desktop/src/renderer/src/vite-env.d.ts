interface ImportMetaEnv {
  /** 构建时设为 1 生成无示例体验的纯真实工作区版本 */
  readonly VITE_MEMO_NO_DEMO?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
