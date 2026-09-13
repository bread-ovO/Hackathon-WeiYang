import { randomUUID } from 'node:crypto'
import {
  parsePetContextConfig,
  type PetContextConfig,
  type PetContextState,
  type PetContextPreview,
  type PetContextFact,
} from '@memo/contracts'
import { isLocalPetModel } from '@memo/model'

export interface ContextStoreState {
  version: 1
  config: PetContextConfig
  day: string
  count: number
  lastNow: number
  lastRequestAt: number
  recent: string[]
}
function fail(code = 'PET_CONTEXT_INVALID_STATE'): never {
  throw new Error(code)
}
const integer = (v: unknown): v is number =>
  Number.isSafeInteger(v) &&
  (v as number) >= 0 &&
  (v as number) <= 8_640_000_000_000_000
export function parseContextStoreState(value: unknown): ContextStoreState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const v = value as Record<string, unknown>
  const keys = [
    'version',
    'config',
    'day',
    'count',
    'lastNow',
    'lastRequestAt',
    'recent',
  ]
  if (
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k)) ||
    v.version !== 1 ||
    typeof v.day !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(v.day) ||
    !Number.isFinite(Date.parse(v.day)) ||
    new Date(v.day).toISOString().slice(0, 10) !== v.day ||
    !integer(v.count) ||
    v.count > 12 ||
    !integer(v.lastNow) ||
    !integer(v.lastRequestAt) ||
    v.lastRequestAt > v.lastNow ||
    !Array.isArray(v.recent) ||
    v.recent.length > 4 ||
    v.recent.some((x) => typeof x !== 'string' || x.length > 256) ||
    new Set(v.recent).size !== v.recent.length
  )
    return fail()
  return {
    version: 1,
    config: parsePetContextConfig(v.config),
    day: v.day,
    count: v.count,
    lastNow: v.lastNow,
    lastRequestAt: v.lastRequestAt,
    recent: [...v.recent] as string[],
  }
}
export interface PreparedContextSpeech {
  text: string
  contextId?: string
}
interface Entry {
  preview: PetContextPreview
  fact: PetContextFact | null
  configVersion: number
  expiresAt: number
}
export interface PetContextServiceDeps {
  store: {
    load(): Promise<ContextStoreState | null>
    save(state: ContextStoreState): Promise<void>
  }
  facts(projectIds: string[]): Promise<PetContextFact[]>
  valid(fact: PetContextFact): Promise<boolean>
  select(input: {
    model: string
    candidates: { ref: string; status: string }[]
    signal: AbortSignal
  }): Promise<{ ref: string; template: 'review' | 'open' }>
  enqueue(text: string, reason: string): string | null
  enqueueFallback(text: string): string | null
  cancelPresentation(id: string): void
  navigate(projectId: string, taskId: string): void
  isCurrent(id: string): boolean
  changed(): void
  now?: () => number
}
const fallback = '需要整理思路时，可以回工作区看看。'
const codes = new Set([
  'PET_MODEL_OFFLINE',
  'PET_MODEL_TIMEOUT',
  'PET_MODEL_INVALID_RESPONSE',
  'PET_MODEL_UNAVAILABLE',
  'PET_MODEL_BUSY',
  'PET_CONTEXT_BUDGET',
  'PET_CONTEXT_COOLDOWN',
])
/** Facts remain local. The model can only select a template and a one-request anonymous ref. */
export function createPetContextService(deps: PetContextServiceDeps) {
  const now = deps.now ?? Date.now
  const initialNow = now()
  let saved: ContextStoreState = {
    version: 1,
    config: {
      version: 1,
      enabled: false,
      projectIds: [],
      useModel: false,
      model: '',
    },
    day: new Date(initialNow).toISOString().slice(0, 10),
    count: 0,
    lastNow: initialNow,
    lastRequestAt: 0,
    recent: [],
  }
  let serial: Promise<unknown> = Promise.resolve()
  let epoch = 0,
    disposed = false,
    failed = false,
    configuring = 0
  let controller: AbortController | null = null
  let result: PetContextState['lastResult'] = 'none',
    error: string | null = null
  const entries = new Map<string, Entry>(),
    shown = new Map<string, Entry>()
  function enqueue<T>(fn: () => Promise<T>) {
    const task = serial.then(fn)
    serial = task.catch(() => undefined)
    return task
  }
  async function save(next: ContextStoreState) {
    try {
      await deps.store.save(parseContextStoreState(next))
      saved = next
    } catch {
      failed = true
      fail('PET_CONTEXT_STORAGE_ERROR')
    }
  }
  const ready = enqueue(async () => {
    try {
      const loaded = await deps.store.load()
      if (loaded) saved = parseContextStoreState(loaded)
    } catch {
      failed = true
      error = 'PET_CONTEXT_STORAGE_ERROR'
      result = 'error'
    }
  })
  function state(): PetContextState {
    return {
      config: structuredClone(saved.config),
      busy: controller !== null || configuring > 0,
      lastResult: result,
      error,
    }
  }
  function clearEntries() {
    entries.clear()
    for (const id of shown.keys()) deps.cancelPresentation(id)
    shown.clear()
  }
  function cancel() {
    epoch++
    controller?.abort()
    clearEntries()
    result = 'cancelled'
    error = null
    return state()
  }
  function check(ticket: number, signal?: AbortSignal) {
    if (disposed || ticket !== epoch || signal?.aborted)
      fail('PET_MODEL_CANCELLED')
    if (failed) fail('PET_CONTEXT_STORAGE_ERROR')
  }
  function prune() {
    const time = now()
    for (const [id, e] of entries)
      if (time > e.expiresAt || time < e.expiresAt - 60_000) entries.delete(id)
    for (const [id, e] of shown)
      if (time > e.expiresAt || time < e.expiresAt - 60_000) {
        deps.cancelPresentation(id)
        shown.delete(id)
      }
  }
  async function reserve(ticket: number, signal: AbortSignal) {
    await enqueue(async () => {
      check(ticket, signal)
      const time = now(),
        day = new Date(time).toISOString().slice(0, 10)
      if (time < saved.lastNow) fail('PET_CONTEXT_COOLDOWN')
      const count = day > saved.day ? 0 : saved.count
      if (count >= 12) fail('PET_CONTEXT_BUDGET')
      if (saved.lastRequestAt > 0 && time - saved.lastRequestAt < 10_000)
        fail('PET_CONTEXT_COOLDOWN')
      await save({
        ...saved,
        day: day > saved.day ? day : saved.day,
        count: count + 1,
        lastNow: time,
        lastRequestAt: time,
      })
      check(ticket, signal)
    })
  }
  async function generate(
    preset: string,
    external?: AbortSignal,
  ): Promise<Entry | null> {
    await ready
    if (disposed || external?.aborted || configuring > 0) return null
    if (failed) fail('PET_CONTEXT_STORAGE_ERROR')
    if (controller) fail('PET_MODEL_BUSY')
    const ticket = epoch,
      config = structuredClone(saved.config)
    const own = new AbortController()
    controller = own
    const abort = () => own.abort()
    external?.addEventListener('abort', abort, { once: true })
    let fact: PetContextFact | null = null,
      mode: PetContextPreview['mode'] = 'local',
      text = preset,
      reason = '本地预设陪伴话语，不引用事项。'
    try {
      check(ticket, own.signal)
      if (config.enabled && config.projectIds.length) {
        const facts = await deps.facts([...config.projectIds])
        check(ticket, own.signal)
        const available = facts.filter((f) => !saved.recent.includes(f.taskId))
        // When all facts were recently mentioned, use a preset instead of repeating.
        const candidates = available
        fact = candidates[0] ?? null
        let template: 'review' | 'open' = 'open'
        if (fact && config.useModel) {
          if (!isLocalPetModel(config.model)) fail('PET_MODEL_UNAVAILABLE')
          try {
            await reserve(ticket, own.signal)
            const refs = candidates.map((f, i) => ({
              ref: `r${i + 1}`,
              status: f.status,
            }))
            const choice = await deps.select({
              model: config.model,
              candidates: refs,
              signal: own.signal,
            })
            check(ticket, own.signal)
            const index = refs.findIndex((x) => x.ref === choice.ref)
            if (index < 0 || !['review', 'open'].includes(choice.template))
              fail('PET_MODEL_INVALID_RESPONSE')
            fact = candidates[index]!
            template = choice.template
            mode = 'model'
          } catch (cause) {
            check(ticket, own.signal)
            fact = null
            mode = 'fallback'
            const code = cause instanceof Error ? cause.message : ''
            error = codes.has(code) ? code : 'PET_MODEL_UNAVAILABLE'
          }
        }
        if (fact) {
          if (!(await deps.valid(fact))) {
            fact = null
            mode = 'fallback'
          }
          check(ticket, own.signal)
        }
        if (fact) {
          const labels: Record<string, string> = {
            todo: '待开始',
            in_progress: '进行中',
            waiting: '等待中',
            completed: '已手动标记完成',
            cancelled: '已取消',
          }
          if (!Object.hasOwn(labels, fact.status))
            fail('PET_CONTEXT_INVALID_STATE')
          text = `${template === 'review' ? '想整理思路时，可以看看' : '方便时，可以打开'}「${fact.title}」。记录状态：${labels[fact.status]}。`
          reason =
            '来自你允许使用的项目；这条事项已收录，并保留了当前有效的依据。'
          if (Array.from(text).length > 240) fail('PET_CONTEXT_INVALID_STATE')
        }
      }
      check(ticket, own.signal)
      const preview: PetContextPreview = {
        id: randomUUID(),
        text,
        reason,
        hasReference: fact !== null,
        mode,
      }
      const entry = {
        preview,
        fact: fact ? structuredClone(fact) : null,
        configVersion: config.version,
        expiresAt: now() + 60_000,
      }
      result = mode
      if (mode !== 'fallback') error = null
      return entry
    } finally {
      external?.removeEventListener('abort', abort)
      if (controller === own) controller = null
    }
  }
  async function usable(e: Entry, ticket: number) {
    prune()
    check(ticket)
    if (
      e.configVersion !== saved.config.version ||
      now() > e.expiresAt ||
      now() < e.expiresAt - 60_000
    )
      return false
    if (
      e.fact &&
      (!saved.config.enabled ||
        !saved.config.projectIds.includes(e.fact.projectId) ||
        !(await deps.valid(e.fact)))
    )
      return false
    check(ticket)
    return (
      e.configVersion === saved.config.version &&
      now() <= e.expiresAt &&
      now() >= e.expiresAt - 60_000
    )
  }
  async function remember(e: Entry, ticket: number) {
    if (!e.fact && saved.recent.length === 0) return
    await enqueue(async () => {
      check(ticket)
      const time = now()
      if (time < saved.lastNow) fail('PET_CONTEXT_COOLDOWN')
      await save({
        ...saved,
        lastNow: time,
        recent: e.fact
          ? [
              ...saved.recent.filter((x) => x !== e.fact!.taskId),
              e.fact.taskId,
            ].slice(-4)
          : saved.recent.slice(1),
      })
      check(ticket)
    })
  }
  return {
    ready,
    state,
    async configure(
      expectedVersion: number,
      input: Omit<PetContextConfig, 'version'>,
    ) {
      const config = parsePetContextConfig({
        ...structuredClone(input),
        version: expectedVersion + 1,
      })
      if (config.useModel && !isLocalPetModel(config.model))
        fail('PET_MODEL_UNAVAILABLE')
      configuring++
      cancel()
      deps.changed()
      try {
        await enqueue(async () => {
          if (disposed || failed) fail('PET_CONTEXT_STORAGE_ERROR')
          if (saved.config.version !== expectedVersion)
            fail('PET_CONTEXT_CONFLICT')
          if (config.projectIds.length) await deps.facts([...config.projectIds])
          await save({ ...saved, config })
          result = 'none'
          error = null
        })
      } finally {
        configuring--
      }
      return state()
    },
    cancel,
    async preview() {
      const e = await generate(fallback)
      if (!e) fail('PET_MODEL_CANCELLED')
      prune()
      entries.clear()
      entries.set(e.preview.id, e)
      return structuredClone(e.preview)
    },
    async prepareAutomatic(
      preset: string,
      signal: AbortSignal,
    ): Promise<PreparedContextSpeech | null> {
      try {
        const e = await generate(preset, signal)
        if (!e || signal.aborted) return null
        prune()
        entries.set(e.preview.id, e)
        while (entries.size > 8) entries.delete(entries.keys().next().value!)
        return { text: e.preview.text, contextId: e.preview.id }
      } catch (cause) {
        if (
          signal.aborted ||
          disposed ||
          (cause instanceof Error && cause.message === 'PET_MODEL_CANCELLED')
        )
          return null
        return { text: preset }
      }
    },
    async deliver(
      prepared: PreparedContextSpeech,
      signal?: AbortSignal,
      guard: () => Promise<boolean> = async () => true,
      current: () => boolean = () => true,
    ): Promise<string | null> {
      if (signal?.aborted || disposed) return null
      if (!prepared.contextId) {
        const ticket = epoch
        if (
          !(await guard()) ||
          signal?.aborted ||
          disposed ||
          ticket !== epoch ||
          !current()
        )
          return null
        return deps.enqueueFallback(prepared.text)
      }
      const e = entries.get(prepared.contextId),
        ticket = epoch
      entries.delete(prepared.contextId)
      if (!e || !(await usable(e, ticket))) return null
      await remember(e, ticket)
      if (!(await usable(e, ticket))) return null
      if (!(await guard()) || signal?.aborted || disposed) return null
      if (!(await usable(e, ticket)) || !current()) return null
      check(ticket, signal)
      if (now() > e.expiresAt || now() < e.expiresAt - 60_000) return null
      const id = e.fact
        ? deps.enqueue(e.preview.text, e.preview.reason)
        : deps.enqueueFallback(e.preview.text)
      if (id) {
        prune()
        shown.set(id, e)
      }
      return id
    },
    async show(id: string) {
      const e = entries.get(id)
      if (!e) fail('PET_CONTEXT_EXPIRED')
      const delivered = await this.deliver({
        text: e.preview.text,
        contextId: id,
      })
      if (!delivered) fail('PET_CONTEXT_UNAVAILABLE')
      return state()
    },
    async open(id: string) {
      const e = shown.get(id),
        ticket = epoch
      if (
        !e?.fact ||
        !deps.isCurrent(id) ||
        !(await usable(e, ticket)) ||
        !deps.isCurrent(id)
      )
        return false
      deps.navigate(e.fact.projectId, e.fact.taskId)
      return true
    },
    invalidateDisplay() {
      cancel()
    },
    dispose() {
      disposed = true
      cancel()
    },
  }
}
