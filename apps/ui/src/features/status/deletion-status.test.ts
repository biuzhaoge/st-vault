import { expect, it } from 'vitest';
import type { MediaDeletionJob } from '@st-vault/api-schema';
import { deletionStatus } from './deletion-status';

const job: MediaDeletionJob = {
  id: 'job',
  subjectId: 'stripchat:42',
  state: 'running',
  total: 1000,
  processed: 128,
  reclaimedBytes: 1024,
  fromMs: 1000,
  toMs: 61000,
  createdAtMs: 1000,
  updatedAtMs: 2000,
  error: null,
};

it('reports an active deletion using real fragment counts and reports preparation as units', () => {
  expect(deletionStatus([job], [])).toEqual({
    text: '正在删除 · stripchat:42 · 已处理 128 / 1,000 个分片',
    tone: 'busy',
  });
  const preparation = {
    ...job,
    state: 'preparing' as const,
    phase: 'units' as const,
    scannedUnits: 256,
  };
  expect(deletionStatus([preparation], [])?.text).toContain('已检查 256 个单元');
  expect(deletionStatus([{ ...job, total: 0 }], [])?.text).not.toContain('已处理');
});

it('prioritizes a job requiring attention and counts the rest in the same line', () => {
  const retry = {
    ...job,
    id: 'retry',
    state: 'retry' as const,
    subjectId: 'stripchat:43',
    error: 'path',
  };
  const result = deletionStatus([job, retry], []);
  expect(result).toMatchObject({ tone: 'warning' });
  expect(result?.text).toContain('删除等待恢复 · stripchat:43');
  expect(result?.text).toContain('另有 1 项删除任务');
  expect(result?.text).not.toContain('path');
});

it('uses the oldest job within a priority and omits completed jobs', () => {
  const older = { ...job, id: 'older', subjectId: 'stripchat:40', createdAtMs: 500 };
  const completed = { ...job, state: 'completed' as const };
  expect(deletionStatus([job, older, completed], [])?.text).toContain('stripchat:40');
  expect(deletionStatus([completed], [])).toBeUndefined();
});

it('shows a stale legacy deletion as canceled history, yielding to new progress', () => {
  const cancelled = { ...job, state: 'failed' as const, error: 'media_selection_stale' };
  const result = deletionStatus([cancelled], []);
  expect(result?.text).toBe('上次删除已取消');
  expect(result?.note).toContain('原录像已保留');
  expect(deletionStatus([cancelled, { ...job, id: 'new' }], [])?.text).toContain('正在删除');
  expect(
    deletionStatus([cancelled, { ...job, state: 'completed', updatedAtMs: 3000 }], []),
  ).toBeUndefined();
});
