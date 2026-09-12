import type { Menu, MenuItemConstructorOptions, NativeImage, Tray } from 'electron'
import { TRAY_ICON_DATA_URL } from './tray-icon'

export interface TrayHost {
  hideToTray(): void
  restoreWindow(): void
  quitApp(): void
}

/** Surface area of an Electron Tray consumed here; keeps tests Electron-free. */
export interface TrayLike {
  setToolTip(toolTip: string): void
  setContextMenu(menu: unknown): void
  on(event: 'click', listener: () => void): void
  destroy(): void
}

/** Opaque platform handles; concrete shapes belong to Electron. */
export interface TrayPlatform {
  createImage(dataUrl: string): unknown
  createTray(image: unknown): TrayLike
  buildFromTemplate(template: readonly TrayTemplateItem[]): unknown
}

export interface TrayTemplateItem {
  label?: string
  type?: 'separator'
  click?: () => void
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

export interface TrayController {
  /** True only while a tray icon is actually shown; drives close-to-tray eligibility. */
  readonly active: boolean
  destroy(): void
}

export function createTrayController(host: TrayHost, platform: TrayPlatform): TrayController {
  try {
    const tray = platform.createTray(platform.createImage(TRAY_ICON_DATA_URL))
    tray.setToolTip('BUGU 不咕')
    tray.setContextMenu(platform.buildFromTemplate([
      { label: '显示主窗口', click: () => host.restoreWindow() },
      { type: 'separator' },
      { label: '退出 BUGU 不咕', click: () => host.quitApp() },
    ]))
    // Windows/macOS: left click restores; menu also offers it where click opens the menu instead.
    tray.on('click', () => host.restoreWindow())
    let destroyed = false
    return {
      get active() { return !destroyed },
      destroy(): void {
        if (destroyed) return
        destroyed = true
        tray.destroy()
      },
    }
  } catch {
    // No system tray (e.g. bare Linux sessions): keep the app usable in classic
    // close-quits mode instead of failing startup. Surfaced for diagnosis only.
    console.error('TRAY_UNAVAILABLE')
    return { get active() { return false }, destroy(): void {} }
  }
}

/**
 * Intercepts window close while the tray owns the lifecycle. The predicate
 * decides per event, so quitting or a dead tray immediately restores the
 * default close behavior.
 */
export function createCloseToTrayGuard(shouldHideToTray: () => boolean, hideToTray: () => void): (event: { preventDefault(): void }) => void {
  return event => {
    if (!shouldHideToTray()) return
    event.preventDefault()
    hideToTray()
  }
}
