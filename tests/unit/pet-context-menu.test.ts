import { describe, it, expect, vi } from 'vitest'
import { petMenuTemplate } from '../../apps/desktop/src/main/pet/context-menu'

function setup(ready = true) {
  const callbacks = {
    open: vi.fn(), play: vi.fn(), scale: vi.fn(), pin: vi.fn(),
    passthrough: vi.fn(), hide: vi.fn(),
  }
  const menu = petMenuTemplate({
    preferences: { scale: 1.25, alwaysOnTop: true, clickThrough: true },
    catalog: { motions: [{ id: 'motion:Idle:0', label: 'Idle & wave' }], expressions: [] },
    ready, ...callbacks,
  })
  const item = (label: string) => menu.find(item => item.label === label)!
  return { callbacks, menu, item }
}
function click(item: any, checked?: boolean) { item.click({ checked }, undefined, {}) }

describe('native pet menu', () => {
  it('routes actions through fixed host callbacks and preserves the action id', () => {
    const { item, callbacks } = setup()
    click(item('打开 BUGU')); click(item('桌宠设置'))
    expect(callbacks.open.mock.calls).toEqual([[false], [true]])
    const actions = item('表情与动作').submenu as any[]
    expect(actions[0].label).toBe('Idle && wave')
    click(actions[0]); expect(callbacks.play).toHaveBeenCalledWith('motion:Idle:0')
    click(item('隐藏桌宠')); expect(callbacks.hide).toHaveBeenCalledOnce()
  })
  it('reflects persisted preferences and supplies bounded scale choices', () => {
    const { item, callbacks } = setup()
    const scales = item('角色大小').submenu as any[]
    expect(scales.filter(s => s.checked).map(s => s.label)).toEqual(['125%'])
    click(scales.at(-1)); expect(callbacks.scale).toHaveBeenCalledWith(2)
    expect(item('置顶显示').checked).toBe(true)
    click(item('置顶显示'), false); expect(callbacks.pin).toHaveBeenCalledWith(false)
    click(item('透明区域穿透'), false); expect(callbacks.passthrough).toHaveBeenCalledWith(false)
  })
  it('disables model actions until the model is ready', () => {
    expect(setup(false).item('表情与动作').enabled).toBe(false)
  })
})
