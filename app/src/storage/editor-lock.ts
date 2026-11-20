import { useEffect, useRef, useState } from 'react';
import { getDatabaseState, prepareDatabase, subscribeDatabaseState } from './repository';

export function useEditorLock() {
  const [owner, setOwner] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [ready, setReady] = useState(false);
  const [upgradePending, setUpgradePending] = useState(false);
  const [error, setError] = useState('');
  const canWrite = useRef(false);
  useEffect(() => {
    let cancelled = false;
    let release: (() => void) | undefined;
    const channel =
      typeof BroadcastChannel === 'undefined'
        ? undefined
        : new BroadcastChannel('rodoslovnaya-database');
    const readExisting = async () => {
      try {
        const available = await prepareDatabase(false);
        if (!cancelled) {
          setReady(available);
          setUpgradePending(!available);
        }
      } catch (cause) {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : 'Не удалось открыть семейный архив.');
      }
    };
    void readExisting();
    if (channel)
      channel.onmessage = () => {
        void readExisting();
      };
    const unsubscribe = subscribeDatabaseState(() => {
      const state = getDatabaseState();
      if (cancelled) return;
      if (state.changed) {
        canWrite.current = false;
        setOwner(false);
        setReady(false);
        setError('Структура базы изменилась. Скопируйте незавершенный ввод и обновите приложение.');
        release?.();
      } else if (state.blocked) {
        setUpgradePending(true);
        setError('Для обновления базы сохраните изменения и закройте старые окна приложения.');
      }
    });
    if (!navigator.locks) {
      setUnsupported(true);
      return () => {
        cancelled = true;
        unsubscribe();
        channel?.close();
      };
    }
    const abort = new AbortController();
    void navigator.locks
      .request('rodoslovnaya-editor-v1', { signal: abort.signal }, async () => {
        if (cancelled) return;
        await prepareDatabase(true);
        if (cancelled) return;
        setReady(true);
        setUpgradePending(false);
        setError('');
        canWrite.current = true;
        setOwner(true);
        channel?.postMessage('ready');
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        canWrite.current = false;
      })
      .catch((error: unknown) => {
        if (!cancelled && !(error instanceof DOMException && error.name === 'AbortError')) {
          setError(error instanceof Error ? error.message : 'Не удалось получить право записи.');
          canWrite.current = false;
          setOwner(false);
        }
      });
    return () => {
      cancelled = true;
      canWrite.current = false;
      release?.();
      abort.abort();
      unsubscribe();
      channel?.close();
    };
  }, []);
  return { owner, unsupported, canWrite, ready, upgradePending, error };
}
