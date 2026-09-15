import { describe, expect, it } from 'vitest'
import { createTaskArrivalTracker } from '../../apps/desktop/src/renderer/src/task-arrivals'
import type { WorkspaceTask } from '@memo/contracts'
const task = (
  id: string,
  admission: WorkspaceTask['admission'] = 'accepted',
): WorkspaceTask => ({
  id,
  admission,
  title: id,
  projectId: 'a',
  status: 'todo',
  evidenceStatus: 'unknown',
  version: 1,
  criteriaVersion: 0,
  manualVersion: 1,
  archivedAt: null,
  dueAt: null,
})
describe('task arrival feedback', () => {
  it('highlights new results and confirmed candidates, but not initial load, ordinary updates or refreshes', () => {
    const observe = createTaskArrivalTracker()
    expect(observe([task('old')], 'all')).toEqual([])
    expect(observe([task('old'), task('new', 'candidate')], 'all')).toEqual([
      'new',
    ])
    expect(observe([task('old'), task('new')], 'all')).toEqual(['new'])
    expect(
      observe(
        [task('old'), { ...task('new'), version: 2, title: 'renamed' }],
        'all',
      ),
    ).toEqual([])
  })
  it('does not animate pagination or project/search/archive navigation', () => {
    const observe = createTaskArrivalTracker()
    observe([task('a')], 'all')
    expect(observe([task('b')], 'all', true)).toEqual([])
    expect(observe([task('a'), task('b')], 'all')).toEqual([])
    expect(observe([task('c')], 'project-b')).toEqual([])
    expect(observe([task('a'), task('b')], 'all')).toEqual([])
    expect(observe([], 'query-none')).toEqual([])
    expect(observe([task('archived')], 'archived')).toEqual([])
  })
})
