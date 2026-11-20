import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { FamilyProject, StoredFile } from '../domain/types';
import { validateProject } from '../domain/model';
import { readSnapshot, saveProject, type SaveOptions } from './repository';

function sameContent(first: FamilyProject, second: FamilyProject): boolean {
  return (
    JSON.stringify({ ...first, revision: 0, updatedAt: '' }) ===
    JSON.stringify({ ...second, revision: 0, updatedAt: '' })
  );
}

export function useProject(canWrite: RefObject<boolean>) {
  const [project, setProject] = useState<FamilyProject | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving' | 'error'>('saved');
  const [error, setError] = useState('');
  const [lastSaved, setLastSaved] = useState<FamilyProject | null>(null);
  const current = useRef<FamilyProject | null>(null);
  const savedSnapshot = useRef<FamilyProject | null>(null);
  const revision = useRef(0);
  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inflight = useRef<Promise<void> | null>(null);

  const restoreSavedIfUnchanged = useCallback(() => {
    if (
      inflight.current ||
      !current.current ||
      !savedSnapshot.current ||
      !sameContent(current.current, savedSnapshot.current)
    )
      return false;
    clearTimeout(timer.current);
    pending.current = false;
    current.current = structuredClone(savedSnapshot.current);
    revision.current = savedSnapshot.current.revision;
    setProject(current.current);
    setSaveState('saved');
    setError('');
    return true;
  }, []);

  const flush = useCallback(
    async function flushPending(): Promise<void> {
      clearTimeout(timer.current);
      if (inflight.current) {
        await inflight.current;
        return flushPending();
      }
      if (restoreSavedIfUnchanged()) return;
      if (!pending.current || !current.current) return;
      if (!canWrite.current) throw new Error('Это окно открыто для чтения. Изменения не записаны.');
      const snapshot = structuredClone(current.current);
      pending.current = false;
      setSaveState('saving');
      const operation = (async () => {
        try {
          const saved = await saveProject(snapshot, revision.current);
          savedSnapshot.current = structuredClone(saved);
          setLastSaved(structuredClone(saved));
          revision.current = saved.revision;
          current.current = {
            ...current.current!,
            revision: saved.revision,
            updatedAt: saved.updatedAt,
          };
          setProject(current.current);
          inflight.current = null;
          if (restoreSavedIfUnchanged()) return;
          setSaveState(pending.current ? 'dirty' : 'saved');
          setError('');
        } catch (cause) {
          pending.current = true;
          inflight.current = null;
          if (restoreSavedIfUnchanged()) return;
          setSaveState('error');
          setError(
            cause instanceof Error
              ? cause.message
              : 'Не удалось сохранить. Введенные сведения оставлены на экране.',
          );
          throw cause;
        }
      })();
      inflight.current = operation;
      try {
        await operation;
      } finally {
        inflight.current = null;
      }
      if (pending.current) await flushPending();
    },
    [canWrite, restoreSavedIfUnchanged],
  );

  const open = useCallback(
    async (next: FamilyProject) => {
      await flush();
      current.current = next;
      savedSnapshot.current = structuredClone(next);
      revision.current = next.revision;
      pending.current = false;
      setProject(next);
      setLastSaved(structuredClone(next));
      setSaveState('saved');
      setError('');
    },
    [flush],
  );

  const edit = useCallback(
    (change: (draft: FamilyProject) => void) => {
      if (!canWrite.current || !current.current) return;
      const next = structuredClone(current.current);
      change(next);
      validateProject(next);
      if (sameContent(next, current.current)) {
        if (!inflight.current) restoreSavedIfUnchanged();
        return;
      }
      current.current = next;
      if (restoreSavedIfUnchanged()) return;
      pending.current = true;
      setProject(next);
      setSaveState('dirty');
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void flush().catch(() => {
          /* Ошибка уже показана, введенные данные сохранены в форме. */
        });
      }, 650);
    },
    [canWrite, flush, restoreSavedIfUnchanged],
  );

  const commit = useCallback(
    async (
      change: (draft: FamilyProject) => void,
      files: StoredFile[] = [],
      options: SaveOptions = {},
    ) => {
      await flush();
      if (!canWrite.current || !current.current)
        throw new Error('Редактирование доступно только в основном окне.');
      const next = structuredClone(current.current);
      change(next);
      const saved = await saveProject(next, revision.current, files, options);
      current.current = saved;
      savedSnapshot.current = structuredClone(saved);
      revision.current = saved.revision;
      setProject(saved);
      setLastSaved(structuredClone(saved));
      setSaveState('saved');
      setError('');
      return saved;
    },
    [canWrite, flush],
  );

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden')
        void flush().catch(() => {
          /* Состояние ошибки показано в приложении. */
        });
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (pending.current || inflight.current) {
        event.preventDefault();
      }
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [flush]);

  const readSavedSnapshot = useCallback(async () => {
    if (!current.current) throw new Error('Архив не открыт.');
    return readSnapshot(current.current.id);
  }, []);

  return {
    project,
    saveState,
    error,
    current,
    open,
    edit,
    flush,
    commit,
    lastSaved,
    readSavedSnapshot,
  };
}
