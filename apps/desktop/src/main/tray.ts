import type { Menu, MenuItemConstructorOptions, NativeImage, Tray } from 'electron'
import { TRAY_ICON_DATA_URL } from './tray-icon'

export interface TrayHost {
  hideToTray(): void
  restoreWindow(): void
  quitApp(): void
}

export interface TrayLike {
  setToolTip(toolTip: string): void
  setContextMenu(menu: unknown): void
  on(event: 'click', listener: () => void): void
  destroy(): void
}

export interface TrayTemplateItem {
  label?: string
  type?: 'separator'
  click?: () => void
}

export interface TrayPlatform {
  createImage(dataUrl: string): unknown
  createTray(image: unknown): TrayLike
  buildFromTemplate(template: readonly TrayTemplateItem[]): unknown
}

export interface ElectronTrayApi {
  Tray: new (image: NativeImage) => Tray
  Menu: { buildFromTemplate(items: MenuItemConstructorOptions[]): Menu }
  nativeImage: { createFromDataURL(dataUrl: string): NativeImage }
}

export function electronTrayPlatform(electron: ElectronTrayApi): TrayPlatform {
  return {
    createImage: dataUrl => electron.nativeImage.createFromDataURL(dataUrl),
    createTray: image => new electron.Tray(image as NativeImage),
    buildFromTemplate: template => electron.Menu.buildFromTemplate(template as MenuItemConstructorOptions[]),
  }
}

export function createTrayController(host: TrayHost, platform: TrayPlatform): { destroy(): void } {
  const tray = platform.createTray(platform.createImage(TRAY_ICON_DATA_URL))
  tray.setToolTip('BUGU 不咕')
  tray.setContextMenu(platform.buildFromTemplate([
    { label: '显示主窗口', click: () => host.restoreWindow() },
    { type: 'separator' },
    { label: '退出 BUGU 不咕', click: () => host.quitApp() },
  ]))
  tray.on('click', () => host.restoreWindow())
  let destroyed = false
  return {
    destroy(): void {
      if (destroyed) return
      destroyed = true
      tray.destroy()
    },
  }
}

export function createCloseToTrayGuard(isQuitting: () => boolean, host: TrayHost): (event: { preventDefault(): void }) => void {
  return event => {
    if (isQuitting()) return
    event.preventDefault()
    host.hideToTray()
  }
}
