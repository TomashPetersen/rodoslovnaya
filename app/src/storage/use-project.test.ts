import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newProject } from '../domain/model';
import { newPerson, type FamilyProject } from '../domain/types';

// Детерминированная оболочка проверяет операции сохранения; поведение React
// и переходов страницы дополнительно проверяется в настоящем браузере.
const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[] }));
vi.mock('react', () => ({
  useState(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [
      hooks.values[index],
      (value: unknown) => {
        hooks.values[index] = value;
      },
    ];
  },
  useRef(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = { current: initial };
    return hooks.values[index];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: () => undefined,
}));
vi.mock('./repository', () => ({ saveProject: vi.fn(), readSnapshot: vi.fn() }));

import { saveProject } from './repository';
import { useProject } from './use-project';

const permission = { current: true };
function renderStore() {
  hooks.cursor = 0;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- В тесте React заменен детерминированной оболочкой.
  return useProject(permission);
}

function saved(project: FamilyProject, revision: number): FamilyProject {
  return {
    ...structuredClone(project),
    revision: revision + 1,
    updatedAt: new Date(Date.parse(project.updatedAt) + 1000).toISOString(),
  };
}

async function openedStore() {
  const project = newProject('Семья');
  project.people.push(newPerson('Анна'));
  project.people[0].biography = 'Сохраненный текст';
  await renderStore().open(project);
  return renderStore();
}

function deferredSave() {
  let resolve!: (project: FamilyProject) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<FamilyProject>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  hooks.cursor = 0;
  hooks.values = [];
  permission.current = true;
  vi.useFakeTimers();
  vi.mocked(saveProject)
    .mockReset()
    .mockImplementation(async (project, revision) => saved(project, revision));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('возврат к сохраненному состоянию', () => {
  it('не записывает повторно неизмененное поле и не увеличивает ревизию', async () => {
    const store = await openedStore();
    store.edit((draft) => {
      draft.people[0].birthDate = '';
    });
    expect(renderStore().saveState).toBe('saved');
    await store.flush();
    expect(saveProject).not.toHaveBeenCalled();
    expect(renderStore().project?.revision).toBe(0);
  });

  it('не объявляет другие ожидающие изменения сохраненными при неизмененном поле', async () => {
    const store = await openedStore();
    store.edit((draft) => {
      draft.people[0].biography = 'Новый текст';
    });
    store.edit((draft) => {
      draft.people[0].birthDate = '';
    });
    expect(renderStore().saveState).toBe('dirty');
    await store.flush();
    expect(saveProject).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveProject).mock.calls[0][0].people[0].biography).toBe('Новый текст');
  });

  it('после постоянного отказа записи принимает возврат всех сохраненных значений без новой записи', async () => {
    const store = await openedStore();
    vi.mocked(saveProject).mockRejectedValue(new DOMException('Нет места', 'QuotaExceededError'));
    store.edit((draft) => {
      draft.people[0].biography = 'Несохраненный текст';
    });
    await expect(store.flush()).rejects.toThrow('Нет места');
    expect(renderStore().saveState).toBe('error');
    store.edit((draft) => {
      draft.people[0].biography = 'Сохраненный текст';
    });
    expect(renderStore().saveState).toBe('saved');
    expect(renderStore().error).toBe('');
    await store.flush();
    expect(saveProject).toHaveBeenCalledTimes(1);
    expect(renderStore().project?.revision).toBe(0);
  });

  it('ожидает незавершенную запись и сохраняет возврат после ее успешного завершения', async () => {
    const store = await openedStore();
    const deferred = deferredSave();
    vi.mocked(saveProject).mockImplementationOnce(() => deferred.promise);
    store.edit((draft) => {
      draft.people[0].biography = 'Первая правка';
    });
    const writing = store.flush();
    store.edit((draft) => {
      draft.people[0].biography = 'Сохраненный текст';
    });
    expect(renderStore().saveState).toBe('dirty');
    const written = vi.mocked(saveProject).mock.calls[0][0];
    deferred.resolve(saved(written, 0));
    await writing;
    expect(saveProject).toHaveBeenCalledTimes(2);
    expect(vi.mocked(saveProject).mock.calls[1][0].people[0].biography).toBe('Сохраненный текст');
    expect(renderStore().saveState).toBe('saved');
    expect(renderStore().project?.revision).toBe(2);
  });

  it('после отказа незавершенной записи возвращает сохраненное без повторения отказавшей операции', async () => {
    const store = await openedStore();
    const deferred = deferredSave();
    vi.mocked(saveProject).mockImplementationOnce(() => deferred.promise);
    store.edit((draft) => {
      draft.people[0].biography = 'Первая правка';
    });
    const writing = store.flush();
    const waiting = store.flush();
    store.edit((draft) => {
      draft.people[0].biography = 'Сохраненный текст';
    });
    deferred.reject(new DOMException('Нет места', 'QuotaExceededError'));
    await Promise.all([writing, waiting]);
    expect(saveProject).toHaveBeenCalledTimes(1);
    expect(renderStore().saveState).toBe('saved');
    expect(renderStore().error).toBe('');
  });

  it('не теряет более новую правку при отказе незавершенной записи', async () => {
    const store = await openedStore();
    const deferred = deferredSave();
    vi.mocked(saveProject).mockImplementationOnce(() => deferred.promise);
    store.edit((draft) => {
      draft.people[0].biography = 'Первая правка';
    });
    const writing = store.flush();
    store.edit((draft) => {
      draft.people[0].biography = 'Более новая правка';
    });
    deferred.reject(new DOMException('Нет места', 'QuotaExceededError'));
    await expect(writing).rejects.toThrow('Нет места');
    expect(renderStore().project?.people[0].biography).toBe('Более новая правка');
    expect(renderStore().lastSaved?.people[0].biography).toBe('Сохраненный текст');
    expect(renderStore().saveState).toBe('error');
    expect(saveProject).toHaveBeenCalledTimes(1);
  });
});
