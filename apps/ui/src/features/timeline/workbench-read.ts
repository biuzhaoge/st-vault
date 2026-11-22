import { request } from '../../shared/lib/api';
import { protectionSubjects } from '../../shared/lib/deletion-projection';
import type { WorkbenchResponse } from './track-data';

export function readWorkbench(
  ids: string[],
  fromMs: number,
  toMs: number,
  buckets: number,
  signal: AbortSignal,
): Promise<WorkbenchResponse> {
  const protection = protectionSubjects(ids);
  const query = `ids=${encodeURIComponent(ids.join(','))}&from=${fromMs}&to=${toMs}&buckets=${buckets}`;
  return request<WorkbenchResponse>(
    `/api/workbench?${query}${protection.length ? `&protection=${encodeURIComponent(protection.join(','))}` : ''}`,
    { signal },
  );
}
