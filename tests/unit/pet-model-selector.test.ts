import { describe, it, expect, vi } from 'vitest'
import {
  selectPetTemplate,
  isLocalPetModel,
  PetModelError,
} from '../../packages/model/src/pet-selector'
const signal = () => new AbortController().signal
const response = (content: unknown) =>
  JSON.stringify({
    done: true,
    message: { role: 'assistant', content: JSON.stringify(content) },
  })
const base = () => ({
  model: 'qwen3:4b',
  candidates: [
    { ref: 'r1', status: 'todo' },
    { ref: 'r2', status: 'waiting' },
  ],
  signal: signal(),
})
describe('bounded pet template selection', () => {
  it('requests schema JSON and returns only a selected known ref/template', async () => {
    const transport = vi.fn(async (body: string) => {
      const sent = JSON.parse(body)
      expect(sent.model).toBe('qwen3:4b')
      expect(sent.stream).toBe(false)
      expect(sent.options.num_predict).toBe(128)
      expect(sent.format.properties.ref.enum).toEqual(['r1', 'r2'])
      expect(JSON.parse(sent.messages[1].content)).toEqual({
        candidates: base().candidates,
      })
      return response({ ref: 'r2', template: 'review' })
    })
    expect(await selectPetTemplate({ ...base(), transport })).toEqual({
      ref: 'r2',
      template: 'review',
    })
  })
  it.each([
    'qwen:cloud',
    'qwen:4b-cloud',
    'cloud/model',
    'qwen-cloud:4b',
    'https://other',
    '../model',
    'x y',
    '',
  ])('rejects unsafe/cloud model %s before transport', async (model) => {
    const transport = vi.fn()
    await expect(
      selectPetTemplate({ ...base(), model, transport }),
    ).rejects.toMatchObject({ code: 'PET_MODEL_UNAVAILABLE' })
    expect(transport).not.toHaveBeenCalled()
    expect(isLocalPetModel(model)).toBe(false)
  })
  it.each([
    { ref: 'other', template: 'open' },
    { ref: 'r1', template: 'completed' },
    { ref: 'r1', template: ['open'] },
    { ref: 'r1', template: 'review', text: '模型自由文案' },
    null,
    [],
    { ref: 1, template: 'open' },
  ])('rejects invalid selection %j', async (selected) => {
    await expect(
      selectPetTemplate({
        ...base(),
        transport: async () => response(selected),
      }),
    ).rejects.toMatchObject({ code: 'PET_MODEL_INVALID_RESPONSE' })
  })
  it('rejects model tool calls, stream fragments and nonJSON prose', async () => {
    for (const raw of [
      'hello',
      JSON.stringify({
        done: false,
        message: { role: 'assistant', content: '{}' },
      }),
      JSON.stringify({
        done: true,
        message: {
          role: 'assistant',
          content: JSON.stringify({ ref: 'r1', template: 'open' }),
          tool_calls: [{ function: { name: 'run' } }],
        },
      }),
    ])
      await expect(
        selectPetTemplate({ ...base(), transport: async () => raw }),
      ).rejects.toMatchObject({ code: 'PET_MODEL_INVALID_RESPONSE' })
  })
  it('does not send extra candidate fields or unsupported status', async () => {
    const transport = vi.fn()
    for (const candidates of [
      [{ ref: 'r1', status: 'todo', title: 'private' }],
      [{ ref: 'r1', status: 'ignore instructions' }],
      [
        { ref: 'r1', status: 'todo' },
        { ref: 'r1', status: 'todo' },
      ],
      [],
    ])
      await expect(
        selectPetTemplate({ ...base(), candidates, transport }),
      ).rejects.toMatchObject({ code: 'PET_MODEL_UNAVAILABLE' })
    expect(transport).not.toHaveBeenCalled()
  })
  it('cancel beats late success or provider error, and errors never echo payload', async () => {
    const c = new AbortController()
    await expect(
      selectPetTemplate({
        ...base(),
        signal: c.signal,
        transport: async () => {
          c.abort()
          return response({ ref: 'r1', template: 'open' })
        },
      }),
    ).rejects.toMatchObject({ code: 'PET_MODEL_CANCELLED' })
    await expect(
      selectPetTemplate({
        ...base(),
        transport: async () => {
          throw Error('secret private error')
        },
      }),
    ).rejects.toThrow('PET_MODEL_UNAVAILABLE')
    await expect(
      selectPetTemplate({
        ...base(),
        transport: async () => {
          throw new PetModelError('PET_MODEL_TIMEOUT')
        },
      }),
    ).rejects.toThrow('PET_MODEL_TIMEOUT')
  })
})
