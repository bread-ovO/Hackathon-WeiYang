import { test, expect } from '@playwright/test'
import { cpus, totalmem, release, platform, arch } from 'node:os'
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import {
  prepareLifecycle,
  lifecycleAssetsReady,
  diagnostics,
  contextCycle,
  haru,
} from './pet-lifecycle-fixture'
async function resources(
  root: string,
  prefix = '',
): Promise<{ path: string; bytes: number; sha256: string }[]> {
  const result: { path: string; bytes: number; sha256: string }[] = []
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name,
      absolute = join(root, path),
      info = await stat(absolute)
    if (info.isDirectory()) result.push(...(await resources(root, path)))
    else if (info.isFile()) {
      const bytes = await readFile(absolute)
      result.push({
        path,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
    }
  }
  return result
}
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}
function trendWindows(
  samples: any[],
  value: (sample: any) => number | null | undefined,
  significantStep: number,
) {
  const windows = [5, 10, 15, 20, 25].map((start) => {
    const group = samples.filter(
      (s) => s.minute >= start && s.minute <= (start === 25 ? 30 : start + 4),
    )
    const values = group
      .map(value)
      .filter((n): n is number => typeof n === 'number')
    return {
      startMinute: start,
      endMinute: start === 25 ? 30 : start + 4,
      median: median(values),
      samples: values.length,
    }
  })
  const xs = windows.map((w) => (w.startMinute + w.endMinute) / 2),
    ys = windows.map((w) => w.median),
    mx = xs.reduce((a, b) => a + b, 0) / xs.length,
    my = ys.reduce((a, b) => a + b, 0) / ys.length
  const slope =
    xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i]! - my), 0) /
    xs.reduce((sum, x) => sum + (x - mx) ** 2, 0)
  let consecutive = 0,
    maxConsecutive = 0
  for (let i = 1; i < ys.length; i++) {
    consecutive = ys[i]! - ys[i - 1]! > significantStep ? consecutive + 1 : 0
    maxConsecutive = Math.max(maxConsecutive, consecutive)
  }
  return {
    windows,
    slopePerMinute: slope,
    maxConsecutiveSignificantIncreases: maxConsecutive,
  }
}
test('PET14 real thirty-minute render soak with process working-set trends', async ({}, testInfo) => {
  test.skip(
    process.env.PET_SOAK_MINUTES !== '30',
    'Opt in with PET_SOAK_MINUTES=30; no simulated clock',
  )
  test.skip(
    !lifecycleAssetsReady,
    'Licensed local Haru/runtime absent; no download',
  )
  test.setTimeout(33 * 60 * 1000)
  const artifact = resolve(
    process.env.PET_SOAK_ARTIFACT ?? 'test-results/pet-soak-report.json',
  )
  await mkdir(dirname(artifact), { recursive: true })
  const fixture = await prepareLifecycle()
  const samples: any[] = [],
    started = Date.now()
  const report: any = {
    schemaVersion: 1,
    thresholds: {
      warmupMinutes: 5,
      windowMinutes: 5,
      workingSetSlopeKiBPerMinute: 1024,
      jsHeapSlopeBytesPerMinute: 262144,
      significantWindowIncreaseWorkingSetKiB: 2048,
      significantWindowIncreaseHeapBytes: 1048576,
      minimumConsecutiveIncreasingWindows: 3,
      processMedianGrowth: 'max(32 MiB, 10% of baseline)',
      heapMedianGrowth: 'max(8 MiB, 20% of baseline)',
      trendRule:
        'Reject excessive median growth or positive regression slope above threshold with three consecutive significantly increasing windows; five-minute medians smooth GC spikes. GPU working set reported separately, never GPU VRAM.',
    },
    status: 'running',
    startedAt: new Date(started).toISOString(),
    requestedMinutes: 30,
    clock: 'real wall clock, no virtual time',
    cpuMeaning:
      'percentCPUUsage is the raw Electron process metric over its sampling interval; not system energy consumption or battery usage.',
    memoryMeaning:
      'Electron app.getAppMetrics memory.workingSetSize in KiB (OS working set, not a strict cross-platform RSS measure). Renderer V8 usedJSHeapSize in bytes. GPU-process working set is NOT GPU VRAM.',
    environment: {
      os: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    model: { ...fixture.model, resources: await resources(haru) },
    samples,
  }
  const save = () => writeFile(artifact, JSON.stringify(report, null, 2))
  try {
    report.versions = await fixture.app.evaluate(() => process.versions)
    report.runtimePins = JSON.parse(
      await readFile(
        resolve('apps/desktop/src/main/pet/runtime-assets.json'),
        'utf8',
      ),
    )
    report.display = await fixture.app.evaluate(({ screen }) =>
      screen
        .getAllDisplays()
        .map((d) => ({ size: d.size, scaleFactor: d.scaleFactor })),
    )
    let previous: { frames: number; at: number; recoveries: number } | undefined
    for (let minute = 0; minute <= 30; minute++) {
      const due = started + minute * 60000
      while (Date.now() < due)
        await fixture.pet.waitForTimeout(Math.min(1000, due - Date.now()))
      const render = await diagnostics(fixture.pet),
        at = Date.now()
      const processMetrics = await fixture.app.evaluate(
        ({ app, BrowserWindow }) => {
          const pet = BrowserWindow.getAllWindows().find((w) =>
            w.webContents.getURL().startsWith('memo-pet://app/'),
          )
          const petPid = pet?.webContents.getOSProcessId()
          return app
            .getAppMetrics()
            .filter(
              (p) =>
                p.type === 'Browser' || p.type === 'GPU' || p.pid === petPid,
            )
            .map((p) => ({
              pid: p.pid,
              role: p.pid === petPid ? 'pet-renderer' : p.type,
              workingSetKiB: p.memory.workingSetSize,
              percentCPUUsage: p.cpu.percentCPUUsage,
              ...(p.memory.privateBytes !== undefined
                ? { privateKiB: p.memory.privateBytes }
                : {}),
            }))
        },
      )
      const usedJSHeapBytes = await fixture.pet.evaluate(() => {
        const p = performance as Performance & {
          memory?: { usedJSHeapSize: number }
        }
        return p.memory?.usedJSHeapSize ?? null
      })
      samples.push({
        minute,
        elapsedSeconds: (at - started) / 1000,
        at: new Date(at).toISOString(),
        ...render,
        observedFps: previous
          ? (render.totalFrames - previous.frames) / ((at - previous.at) / 1000)
          : null,
        usedJSHeapBytes,
        processes: processMetrics,
      })
      previous = {
        frames: render.totalFrames,
        at,
        recoveries: render.recoveries,
      }
      await save()
      console.log(
        JSON.stringify({
          petSoakMinute: minute,
          elapsedSeconds: (at - started) / 1000,
          frames: render.frames,
          artifact,
        }),
      )
      expect(render.error).toBeNull()
      expect(render.frames).toBeGreaterThan(0)
      if (minute === 30) break
      // Exercise a real model action each minute and restore the context every five minutes.
      const action =
        fixture.catalog.motions.find((m) => m.label.startsWith('TapBody')) ??
        fixture.catalog.motions[0]
      if (action)
        expect(
          (
            await fixture.main.evaluate(
              (id) => window.memo.pet.play(id),
              action.id,
            )
          ).ok,
        ).toBe(true)
      if (minute > 0 && minute % 5 === 0) {
        await contextCycle(fixture.pet)
        expect(
          (await fixture.main.evaluate(() => window.memo.health())).ok,
        ).toBe(true)
      }
    }
    report.elapsedSeconds = (Date.now() - started) / 1000
    const baseline = samples.filter((s) => s.minute >= 5 && s.minute <= 9),
      tail = samples.filter((s) => s.minute >= 26)
    report.trends = []
    for (const role of ['Browser', 'GPU', 'pet-renderer']) {
      const values = (group: any[]) =>
        group
          .map(
            (s) => s.processes.find((p: any) => p.role === role)?.workingSetKiB,
          )
          .filter((n: unknown): n is number => typeof n === 'number')
      const first = values(baseline),
        last = values(tail)
      expect(first.length, `${role} baseline samples`).toBe(5)
      expect(last.length, `${role} final samples`).toBe(5)
      const base = median(first),
        end = median(last),
        allowedGrowthKiB = Math.max(32 * 1024, base * 0.1)
      const pids = new Set(
        samples.flatMap((s) =>
          s.processes
            .filter((p: any) => p.role === role)
            .map((p: any) => p.pid),
        ),
      )
      const regression = trendWindows(
        samples,
        (s) => s.processes.find((p: any) => p.role === role)?.workingSetKiB,
        2048,
      )
      report.trends.push({
        role,
        ...regression,
        baselineMedianWorkingSetKiB: base,
        finalMedianWorkingSetKiB: end,
        growthKiB: end - base,
        allowedGrowthKiB,
        processRestarts: pids.size - 1,
        passed:
          pids.size === 1 &&
          end - base <= allowedGrowthKiB &&
          !(
            regression.slopePerMinute > 1024 &&
            regression.maxConsecutiveSignificantIncreases >= 2
          ),
      })
    }
    const heapStart = baseline.map((s) => s.usedJSHeapBytes),
      heapEnd = tail.map((s) => s.usedJSHeapBytes)
    expect(
      heapStart.every((n) => typeof n === 'number') &&
        heapEnd.every((n) => typeof n === 'number'),
      'V8 heap metric required',
    ).toBe(true)
    const baseHeap = median(heapStart),
      endHeap = median(heapEnd)
    const heapRegression = trendWindows(
      samples,
      (s) => s.usedJSHeapBytes,
      1048576,
    )
    report.heapTrend = {
      ...heapRegression,
      baselineMedianBytes: baseHeap,
      finalMedianBytes: endHeap,
      growthBytes: endHeap - baseHeap,
      allowedGrowthBytes: Math.max(8 * 1024 * 1024, baseHeap * 0.2),
      passed:
        endHeap - baseHeap <= Math.max(8 * 1024 * 1024, baseHeap * 0.2) &&
        !(
          heapRegression.slopePerMinute > 262144 &&
          heapRegression.maxConsecutiveSignificantIncreases >= 2
        ),
    }
    report.status = 'completed'
    await save()
    expect(report.elapsedSeconds).toBeGreaterThanOrEqual(1800)
    expect(
      report.trends.every((t: any) => t.passed),
      'Warmup-adjusted process growth/restart thresholds',
    ).toBe(true)
    expect(
      report.heapTrend.passed,
      'Warmup-adjusted V8 heap growth threshold',
    ).toBe(true)
    await testInfo.attach('pet-soak-report', {
      path: artifact,
      contentType: 'application/json',
    })
  } catch (error) {
    report.status = 'failed'
    report.failure = 'SOAK_ASSERTION_OR_RUNTIME_FAILURE' // Keep local paths and process diagnostics out of the public artifact.
    await save()
    throw error
  } finally {
    report.finishedAt = new Date().toISOString()
    await save()
    await fixture.close()
  }
})
