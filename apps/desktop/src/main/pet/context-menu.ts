import type { MenuItemConstructorOptions } from 'electron'
import type { PetActionCatalog } from '@memo/contracts'

/** Native menu actions are supplied by the host, never by model or renderer data. */
export function petMenuTemplate(input: {
  preferences: { scale: number; alwaysOnTop: boolean; clickThrough: boolean; performanceMode?: 'balanced' | 'smooth' }
  catalog: PetActionCatalog
  ready: boolean
  open(settings: boolean): void
  play(id: string): void
  scale(value: number): void
  pin(value: boolean): void
  passthrough(value: boolean): void
  performance(value: 'balanced' | 'smooth'): void
  hide(): void
}): MenuItemConstructorOptions[] {
  const actions = [...input.catalog.motions, ...input.catalog.expressions]
  return [
    { label: '打开 BUGU', click: () => input.open(false) },
    { label: '桌宠设置', click: () => input.open(true) },
    { type: 'separator' },
    {
      label: '表情与动作', enabled: input.ready && actions.length > 0,
      submenu: actions.map(action => ({
        // Electron interprets ampersands as mnemonics on Windows.
        label: action.label.replaceAll('&', '&&'),
        click: () => input.play(action.id),
      })),
    },
    {
      label: '角色大小', submenu: [0.5, 0.75, 1, 1.25, 1.5, 2].map(scale => ({
        label: `${scale * 100}%`, type: 'radio',
        checked: input.preferences.scale === scale,
        click: () => input.scale(scale),
      })),
    },
    {
      label: '置顶显示', type: 'checkbox', checked: input.preferences.alwaysOnTop,
      click: item => input.pin(item.checked),
    },
    {
      label: '透明区域穿透', type: 'checkbox', checked: input.preferences.clickThrough,
      click: item => input.passthrough(item.checked),
    },
    { label: '动画性能', submenu: [
      { label: '省电 · 空闲 30 FPS，交互 60 FPS', type: 'radio', checked: input.preferences.performanceMode !== 'smooth', click: () => input.performance('balanced') },
      { label: '流畅 · 始终 60 FPS', type: 'radio', checked: input.preferences.performanceMode === 'smooth', click: () => input.performance('smooth') },
    ] },
    { type: 'separator' },
    { label: '隐藏桌宠', click: input.hide },
  ]
}
