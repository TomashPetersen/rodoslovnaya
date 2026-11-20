import type { ProjectSnapshot } from '../domain/types';
import type { ArchiveProgress, ArchiveTaskOptions } from './archive';
export type { ArchiveProgress, ArchiveTaskOptions } from './archive';
export { computeArchiveChecksum } from './archive';

export type ArchiveRequest =
  { type: 'export'; snapshot: ProjectSnapshot } | { type: 'import'; archive: Blob };
export type ArchiveResponse =
  | { type: 'progress'; progress: ArchiveProgress }
  | { ok: true; result: Blob | ProjectSnapshot }
  | { ok: false; error: string };

async function runArchiveTask(
  request: ArchiveRequest,
  options: ArchiveTaskOptions,
): Promise<Blob | ProjectSnapshot> {
  if (options.signal?.aborted) throw new DOMException('Операция отменена.', 'AbortError');
  const worker = new Worker(new URL('./archive.worker.ts', import.meta.url), { type: 'module' });
  let terminated = false;
  const terminate = () => {
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    if (!terminated) worker.terminate();
    terminated = true;
  };
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise((resolve, reject) => {
      onAbort = () => {
        terminate();
        reject(new DOMException('Операция отменена.', 'AbortError'));
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      worker.onmessage = (event: MessageEvent<ArchiveResponse>) => {
        if ('type' in event.data && event.data.type === 'progress') {
          options.onProgress?.(event.data.progress);
          return;
        }
        if (!('ok' in event.data)) return;
        if (event.data.ok) resolve(event.data.result);
        else reject(new Error(event.data.error));
      };
      worker.onerror = () => reject(new Error('Не удалось обработать архив. Попробуйте еще раз.'));
      worker.onmessageerror = () =>
        reject(new Error('Не удалось получить результат обработки архива.'));
      worker.postMessage(request);
    });
  } finally {
    if (onAbort) options.signal?.removeEventListener('abort', onAbort);
    terminate();
  }
}

export async function exportArchiveInWorker(
  snapshot: ProjectSnapshot,
  options: ArchiveTaskOptions = {},
): Promise<Blob> {
  const result = await runArchiveTask({ type: 'export', snapshot }, options);
  if (!(result instanceof Blob)) throw new Error('Неверный результат создания копии.');
  return result;
}

export async function importArchiveInWorker(
  archive: Blob,
  options: ArchiveTaskOptions = {},
): Promise<ProjectSnapshot> {
  const result = await runArchiveTask({ type: 'import', archive }, options);
  if (result instanceof Blob) throw new Error('Неверный результат чтения копии.');
  return result;
}
