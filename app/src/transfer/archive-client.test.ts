import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newProject } from '../domain/model';
import {
  exportArchiveInWorker,
  importArchiveInWorker,
  type ArchiveRequest,
  type ArchiveResponse,
} from './archive-client';

class ControlledWorker {
  static instances: ControlledWorker[] = [];
  onmessage: ((event: MessageEvent<ArchiveResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  request?: ArchiveRequest;
  constructor() {
    ControlledWorker.instances.push(this);
  }
  postMessage(request: ArchiveRequest) {
    this.request = request;
  }
  reply(response: ArchiveResponse) {
    this.onmessage?.({ data: response } as MessageEvent<ArchiveResponse>);
  }
}

beforeEach(() => {
  ControlledWorker.instances = [];
  vi.stubGlobal('Worker', ControlledWorker);
});
afterEach(() => vi.unstubAllGlobals());

describe('Задача копирования в вычислительном потоке', () => {
  it('передает этапы, возвращает результат и освобождает обработчики', async () => {
    const seen: string[] = [];
    const pending = exportArchiveInWorker(
      { project: newProject('Семья'), files: [] },
      {
        onProgress: (progress) => seen.push(progress.stage),
      },
    );
    const worker = ControlledWorker.instances[0];
    expect(worker.request?.type).toBe('export');
    worker.reply({ type: 'progress', progress: { stage: 'reading', completed: 1, total: 2 } });
    const archive = new Blob(['zip']);
    worker.reply({ ok: true, result: archive });
    await expect(pending).resolves.toBe(archive);
    expect(seen).toEqual(['reading']);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.onmessage).toBeNull();
    worker.reply({ type: 'progress', progress: { stage: 'complete' } });
    expect(seen).toEqual(['reading']);
  });

  it('немедленно прекращает работу при отмене и не принимает поздний результат', async () => {
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = importArchiveInWorker(new Blob(['zip']), { signal: controller.signal });
    const worker = ControlledWorker.instances[0];
    controller.abort();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    worker.reply({ ok: true, result: { project: newProject('Поздний результат'), files: [] } });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('не запускает поток для заранее отмененной задачи', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      importArchiveInWorker(new Blob(['zip']), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(ControlledWorker.instances).toHaveLength(0);
  });

  it('прекращает поток при отказе обработки и ошибке связи', async () => {
    const failed = exportArchiveInWorker({ project: newProject('Семья'), files: [] });
    ControlledWorker.instances[0].reply({ ok: false, error: 'Поврежденный файл.' });
    await expect(failed).rejects.toThrow('Поврежденный файл.');
    expect(ControlledWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
    const broken = importArchiveInWorker(new Blob(['zip']));
    ControlledWorker.instances[1].onmessageerror?.();
    await expect(broken).rejects.toThrow(/получить результат/);
    expect(ControlledWorker.instances[1].terminate).toHaveBeenCalledTimes(1);
  });

  it('не превращает завершенную обработку в отмену после результата', async () => {
    const controller = new AbortController();
    const pending = exportArchiveInWorker(
      { project: newProject('Семья'), files: [] },
      {
        signal: controller.signal,
      },
    );
    const archive = new Blob(['zip']);
    ControlledWorker.instances[0].reply({ ok: true, result: archive });
    await expect(pending).resolves.toBe(archive);
    controller.abort();
    expect(ControlledWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
  });
});
