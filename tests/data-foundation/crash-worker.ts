import { openFoundationStore as openStore } from '@memo/storage/foundation'
import { writeSync } from 'node:fs'
import { event, page, probe, NOW, jobProposal } from './fixtures'
const [path, mode, point, time] = process.argv.slice(2)
if (!path || !mode || !point) throw new Error('INVALID_TEST_ARGUMENTS')
const kill = () => {
  writeSync(1, 'TEST_CRASH_BARRIER\n')
  process.kill(process.pid, 'SIGKILL')
}
const s = openStore(path, {
  now: () => (time ? Number(time) : NOW),
  probe,
  fault: (p) => {
    if (p === point) kill()
  },
})
if (mode === 'page') {
  const p = page(s, [event(1, 'crash-a'), event(1, 'crash-b')], 'crash-batch')
  s.receivePage(p, { sourceInstanceId: 'source', scopeEpoch: p.scopeEpoch })
} else {
  const lease = s.claimJob('crash-worker', ['v1'], 100)
  if (!lease) throw new Error('MISSING_TEST_JOB')
  if (point === 'after-claim') kill()
  if (mode === 'save') {
    s.saveProposal(lease, jobProposal(s, lease))
    if (point === 'after-save') kill()
  }
  if (mode === 'job') s.commitJob(lease, jobProposal(s, lease))
}
s.close()
