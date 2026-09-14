import { test, expect } from '@playwright/test'
import { prepareLifecycle, diagnostics } from './pet-lifecycle-fixture'

test('custom model loop frame rate in an isolated workspace', async ({}, testInfo) => {
  const directory = process.env.PET_BENCH_MODEL_DIRECTORY
  test.skip(!directory, 'Opt in with a local model asset directory; no user workspace is read')
  test.setTimeout(90000)
  const fixture = await prepareLifecycle(directory!, process.env.PET_BENCH_MODEL_ENTRY ?? 'seio-loop.model3.json')
  try {
    const { pet } = fixture
    const mode = process.env.PET_BENCH_MODE === 'smooth' ? 'smooth' : 'balanced'
    const target = mode === 'smooth' ? 60 : 30
    expect((await fixture.main.evaluate(mode => window.memo.pet.configure({ performanceMode: mode === 'smooth' ? 'smooth' : 'balanced' }), mode)).ok).toBe(true)
    await pet.mouse.move(0, 0)
    await pet.waitForTimeout(4500)
    await expect.poll(async () => (await diagnostics(pet)).targetFps).toBe(target)
    await pet.waitForTimeout(2000)
    const profiler = process.env.PET_BENCH_PROFILE ? await pet.context().newCDPSession(pet) : null
    if (profiler) { await profiler.send('Profiler.enable'); await profiler.send('Profiler.start') }
    const cpuStart = await fixture.app.evaluate(({ app }) => app.getAppMetrics().map(p => ({pid:p.pid,type:p.type,seconds:p.cpu.cumulativeCPUUsage})))
    const start = await diagnostics(pet), at = Date.now()
    await pet.waitForTimeout(10000)
    const end = await diagnostics(pet)
    const fps = (end.frames - start.frames) * 1000 / (Date.now() - at)
    if (profiler) {
      const { profile } = await profiler.send('Profiler.stop')
      console.log(JSON.stringify(profile.nodes.filter(n => n.hitCount).sort((a,b) => (b.hitCount ?? 0)-(a.hitCount ?? 0)).slice(0,20).map(n => ({function:n.callFrame.functionName,url:n.callFrame.url,hits:n.hitCount}))))
      await profiler.detach()
    }
    const seconds = (Date.now() - at) / 1000
    const cpuEnd = await fixture.app.evaluate(({ app }) => app.getAppMetrics().map(p => ({pid:p.pid,type:p.type,seconds:p.cpu.cumulativeCPUUsage})))
    const cpu = cpuEnd.map(p => {
      const before = cpuStart.find(b => b.pid === p.pid)?.seconds
      return { type: p.type, cpuPercent: p.seconds === undefined || before === undefined ? null : 100 * (p.seconds - before) / seconds }
    })
    expect(end.error).toBeNull()
    expect(fps).toBeGreaterThanOrEqual(target * 0.85)
    await testInfo.attach('model-fps.json', { body: JSON.stringify({fps, targetFps:end.targetFps,cpu}), contentType:'application/json' })
    console.log(JSON.stringify({fps, targetFps:end.targetFps,cpu}))
  } finally { await fixture.close() }
})
