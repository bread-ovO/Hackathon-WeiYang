import { test, expect, _electron as electron } from '@playwright/test'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
const desktopRequire = createRequire(resolve('apps/desktop/package.json'))
const runtime = resolve('.pet-sdk/runtime'),
  haru = resolve('.pet-sdk/CubismSdkForWeb-5-r.5/Samples/Resources/Haru')
for (const rendering of [false, true])
  test(
    rendering
      ? 'muted real system PCM reaches pet playback and stop retains bubble'
      : 'voice settings default off and only list actual OS voices',
    async () => {
      test.setTimeout(120000)
      test.skip(
        rendering &&
          (!existsSync(join(runtime, 'framework.js')) ||
            !existsSync(join(haru, 'Haru.model3.json'))),
        'Licensed SDK unavailable; no download',
      )
      const root = await realpath(
        await mkdtemp(join(tmpdir(), 'bugu-voice-ui-')),
      )
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (v): v is [string, string] => v[1] !== undefined,
        ),
      )
      delete env.ELECTRON_RUN_AS_NODE
      delete env.ELECTRON_RENDERER_URL
      env.MEMO_TEST_USER_DATA = join(root, 'profile')
      const app = await electron.launch({
        executablePath: desktopRequire('electron'),
        args: [resolve('apps/desktop/out/main/index.js'), '--mute-audio'],
        env,
      })
      try {
        const main = await app.firstWindow()
        await expect(
          main.getByRole('heading', { name: '跟进', exact: true }),
        ).toBeVisible()
        expect(
          await app.evaluate(({ app }) =>
            app.commandLine.hasSwitch('mute-audio'),
          ),
        ).toBe(true)
        await main.getByRole('button', { name: '设置', exact: true }).click()
    await main.locator('#settings-voice > summary').click()
    await main.locator('#settings-pet > summary').click()
        const panel = main.getByRole('region', { name: '桌宠声音' })
        await expect(
          panel.getByRole('checkbox', { name: '允许桌宠播音' }),
        ).not.toBeChecked()
        const initial = await main.evaluate(() => window.memo.pet.voiceState())
        expect(initial.ok).toBe(true)
        if (!initial.ok) throw Error('VOICE_STATE_FAILED')
        expect(initial.data.preferences.enabled).toBe(false)
        expect(initial.data.preferences.voiceId).toBeNull()
        await expect(
          panel.getByLabel('系统声音').locator('option'),
        ).toHaveCount(initial.data.voices.length + 1)
        await panel.screenshot({
          path: 'test-results/pet-voice-settings-wide.png',
        })
        await main.setViewportSize({ width: 880, height: 820 })
        await panel.screenshot({
          path: 'test-results/pet-voice-settings-narrow.png',
        })
        if (!initial.data.available || !initial.data.voices.length) {
          await expect(
            panel.getByRole('checkbox', { name: '允许桌宠播音' }),
          ).toBeDisabled()
          test.skip(
            rendering,
            'OS did not report an installed voice; no synthetic enumeration',
          )
          return
        }
        const voice =
          initial.data.voices.find((v) => v.language.startsWith('zh')) ??
          initial.data.voices[0]!
        await panel.getByLabel('系统声音').selectOption(voice.id)
        await panel.getByRole('checkbox', { name: '允许桌宠播音' }).check()
        await panel.getByLabel('桌宠音量').fill('0.4')
        await panel.getByLabel('桌宠语速').fill('1')
        await panel.getByRole('button', { name: '保存声音设置' }).click()
        await expect(
          panel.getByText('声音设置已保存，从下一条话语生效。'),
        ).toBeVisible()
        const saved = await main.evaluate(() => window.memo.pet.voiceState())
        expect(saved.ok && saved.data.preferences.voiceId).toBe(voice.id)
        if (!rendering) return
        const picker = async (path: string) =>
          app.evaluate(
            ({ dialog }, path) =>
              Object.defineProperty(dialog, 'showOpenDialog', {
                configurable: true,
                value: async () => ({ canceled: false, filePaths: [path] }),
              }),
            path,
          )
        await picker(haru)
        const chosen = await main.evaluate(() =>
          window.memo.pet.openImportDialog(),
        )
        if (!chosen.ok || !('sessionId' in chosen.data))
          throw Error('NO_MODEL_SESSION')
        const imported = await main.evaluate(
          (id) => window.memo.pet.importChosen(id, 'Haru.model3.json'),
          chosen.data.sessionId,
        )
        if (!imported.ok || imported.data.status === 'invalid')
          throw Error('MODEL_INVALID')
        expect(
          (
            await main.evaluate(
              (id) => window.memo.pet.select(id),
              imported.data.model.id,
            )
          ).ok,
        ).toBe(true)
        await picker(runtime)
        expect(
          (await main.evaluate(() => window.memo.pet.installRuntime())).ok,
        ).toBe(true)
        expect((await main.evaluate(() => window.memo.pet.show())).ok).toBe(
          true,
        )
        await expect
          .poll(
            async () => {
              const r = await main.evaluate(() => window.memo.pet.state())
              return r.ok ? r.data.renderStatus : null
            },
            { timeout: 30000 },
          )
          .toBe('ready')
        expect(
          (
            await main.evaluate(() => {
              const d = new Date(),
                minute = d.getHours() * 60 + d.getMinutes()
              return window.memo.pet.configureSpeech({
                quietStart: (minute + 60) % 1440,
                quietEnd: (minute + 61) % 1440,
              })
            })
          ).ok,
        ).toBe(true)
        const pet = app.windows().find((p) => p !== main)!
        const text = '这是合成语音验收，请看看这条文字。'
        expect(
          (await main.evaluate((text) => window.memo.pet.speak({ text }), text))
            .ok,
        ).toBe(true)
        await expect
          .poll(
            async () => {
              const r = await main.evaluate(() => window.memo.pet.voiceState())
              return r.ok ? r.data.status : null
            },
            { timeout: 25000, intervals: [50, 100] },
          )
          .toBe('playing')
        const lipEvidence = await pet.evaluate(async () => {
          const samples: {
            level: number | null
            playing: boolean
            frames: number
            parameters: { index: number; value: number }[]
          }[] = []
          for (let n = 0; n < 16; n++) {
            const d = (
              window as unknown as {
                __petRender: {
                  audioPlaying: boolean
                  lipSyncAvailable: boolean
                  lipSyncLevel: number | null
                  lipSyncAppliedFrames: number
                  lipSyncParameters: { index: number; value: number }[]
                }
              }
            ).__petRender
            if (!d.lipSyncAvailable) throw Error('HARU_LIPSYNC_UNAVAILABLE')
            samples.push({
              level: d.lipSyncLevel,
              playing: d.audioPlaying,
              frames: d.lipSyncAppliedFrames,
              parameters: d.lipSyncParameters.map((p) => ({ ...p })),
            })
            await new Promise((r) => setTimeout(r, 32))
          }
          return samples
        })
        expect(lipEvidence.some((s) => s.playing && (s.level ?? 0) > 0)).toBe(
          true,
        )
        expect(lipEvidence.at(-1)!.frames).toBeGreaterThan(
          lipEvidence[0]!.frames,
        )
        expect(lipEvidence.some((s) => s.parameters.length > 0)).toBe(true)
        expect(
          new Set(lipEvidence.map((s) => JSON.stringify(s.parameters))).size,
        ).toBeGreaterThan(1)
        await writeFile(
          'test-results/pet-voice-real-pcm-lipsync.json',
          JSON.stringify(lipEvidence, null, 2),
        )
        await expect(pet.locator('#pet-bubble-text')).toHaveText(text)
        expect(
          (await main.evaluate(() => window.memo.pet.stopVoice())).ok,
        ).toBe(true)
        await expect
          .poll(async () => {
            const r = await main.evaluate(() => window.memo.pet.voiceState())
            return r.ok ? r.data.status : null
          })
          .not.toBe('playing')
        await expect(pet.locator('#pet-bubble-text')).toHaveText(text)
        await main.waitForTimeout(1500)
        const stopped = await main.evaluate(() => window.memo.pet.voiceState())
        expect(stopped.ok && stopped.data.status).not.toBe('playing')
      } finally {
        await app.close()
        await rm(root, { recursive: true, force: true })
      }
    },
  )
