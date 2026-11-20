import { exportArchive, importArchive } from './archive';
import type { ArchiveRequest, ArchiveResponse } from './archive-client';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ArchiveRequest>) => void) | null;
  postMessage: (response: ArchiveResponse) => void;
};

scope.onmessage = (event) => {
  void (async () => {
    try {
      const request = event.data;
      const options = {
        onProgress: (progress: import('./archive').ArchiveProgress) =>
          scope.postMessage({ type: 'progress', progress }),
      };
      const result =
        request.type === 'export'
          ? await exportArchive(request.snapshot, options)
          : await importArchive(request.archive, options);
      scope.postMessage({ ok: true, result });
    } catch (cause) {
      scope.postMessage({
        ok: false,
        error: cause instanceof Error ? cause.message : 'Не удалось обработать архив.',
      });
    }
  })();
};
