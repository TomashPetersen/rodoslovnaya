import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';
import type { TreeViewState } from './components/FamilyTree';
import {
  addRelationship,
  getActiveRecords,
  moveToTrash,
  purgeMedia,
  restoreTrashGroup,
  setPortrait,
  updateMaterialPeople,
  updateRelationship,
} from './domain/model';
import {
  newPerson,
  type FamilyProject,
  type Media,
  type Person,
  type ProjectSnapshot,
  type Relationship,
  type Story,
  type StoredFile,
  type TrashGroup,
} from './domain/types';
import {
  createProject,
  importSnapshot,
  loadBackupStatus,
  loadProjects,
  readSnapshot,
  saveBackupStatus,
  markBackupVerified,
  type BackupStatus,
} from './storage/repository';
import { useEditorLock } from './storage/editor-lock';
import { useProject } from './storage/use-project';
import { createEdition, getEditionCandidates } from './transfer/edition';
import {
  exportArchiveInWorker,
  importArchiveInWorker,
  computeArchiveChecksum,
  type ArchiveProgress,
} from './transfer/archive-client';
import { calculateCapacity, CAPACITY_MESSAGES } from './domain/capacity';
import { download, prepareMedia } from './media';
import PersonEditor from './components/PersonEditor';
import MaterialsView from './components/MaterialsView';
import ArchiveView, { EmergencyFiles } from './components/ArchiveView';
import { MaterialForm, NameForm, RelativeForm } from './components/EntryForms';
import {
  dateLabel,
  initials,
  message,
  Modal,
  sizeLabel,
  statusLabels,
  useFileUrls,
  type FieldDraft,
  type PersonField,
} from './components/editor-common';

const FamilyTree = lazy(() => import('./components/FamilyTree'));
type Section = 'tree' | 'people' | 'materials' | 'archive';
type CardContext = {
  selectedId: string | null;
  treeRootId: string | null;
  section: Section;
  showDetail: boolean;
  query: string;
  view?: TreeViewState;
};
type Dialog =
  | { kind: 'person' }
  | { kind: 'rename' }
  | { kind: 'relative'; relationship?: Relationship }
  | { kind: 'material'; entry?: Media | Story; type: 'media' | 'story'; personId?: string }
  | { kind: 'view'; media: Media }
  | { kind: 'shorten'; group: TrashGroup };
type Confirmation = {
  title: string;
  text: string;
  action: string;
  resolve: (result: boolean) => void;
  file?: { blob: Blob; name: string };
};
type RelativeValue = {
  role: 'parent' | 'child' | 'partner';
  mode: 'new' | 'existing';
  name: string;
  otherId: string;
  kind: 'biological' | 'adoptive';
  status: 'together' | 'separated';
};
const sections: { id: Section; name: string; icon: string }[] = [
  { id: 'tree', name: 'Дерево', icon: '⌘' },
  { id: 'people', name: 'Люди', icon: '♧' },
  { id: 'materials', name: 'Материалы', icon: '▧' },
  { id: 'archive', name: 'Архив', icon: '↗' },
];
const progressLabels = {
  checking: 'Проверяем состав',
  reading: 'Читаем файлы',
  hashing: 'Проверяем контрольные суммы',
  packing: 'Формируем файл',
  validating: 'Проверяем восстановление',
  complete: 'Подготовка завершена',
};

export default function App() {
  const lock = useEditorLock();
  const store = useProject(lock.canWrite);
  const { project, saveState, error: saveError, current, open, edit, flush, commit } = store;
  const [projects, setProjects] = useState<FamilyProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [writeReady, setWriteReady] = useState(false);
  const [section, setSection] = useState<Section>('tree');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [treeRootId, setTreeRootId] = useState<string | null>(null);
  const cardHistory = useRef<CardContext[]>([]);
  const [showDetail, setShowDetail] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('');
  const [materialReturn, setMaterialReturn] = useState<Section | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [serviceWarning, setServiceWarning] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [drafts, setDrafts] = useState<Record<string, FieldDraft>>({});
  const [captionDrafts, setCaptionDrafts] = useState<Record<string, FieldDraft>>({});
  const [offlineReady, setOfflineReady] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const updateService = useRef<((reload?: boolean) => Promise<void>) | null>(null);
  const [viewStates, setViewStates] = useState<Record<string, TreeViewState>>({});
  const [editionIds, setEditionIds] = useState<string[]>([]);
  const [editionMedia, setEditionMedia] = useState<string[]>([]);
  const [editionStories, setEditionStories] = useState<string[]>([]);
  const [edition, setEdition] = useState('');
  const [editionKey, setEditionKey] = useState('');
  const [backup, setBackup] = useState<BackupStatus>();
  const [emergency, setEmergency] = useState<ProjectSnapshot | null>(null);
  const [progress, setProgress] = useState<ArchiveProgress | null>(null);
  const abort = useRef<AbortController | null>(null);
  const previousStatuses = useRef<Record<string, string>>({});
  const urls = useFileUrls(files);
  const originalUrls = useFileUrls(files, true);
  const active = useMemo(() => (project ? getActiveRecords(project) : null), [project]);
  const person = active?.people.find((p) => p.id === selectedId) ?? null;
  const disabled = busy || !lock.owner || !writeReady || !lock.ready;
  const capacity = useMemo(
    () => (project ? calculateCapacity(project, files) : null),
    [project, files],
  );
  const protectedMode = !!capacity && !capacity.ok;
  const candidates = useMemo(
    () =>
      project
        ? getEditionCandidates(project, editionIds)
        : { media: [], stories: [], excludedPdfCount: 0 },
    [project, editionIds],
  );
  const selectionKey = JSON.stringify([
    project?.id,
    project?.revision,
    editionIds,
    editionMedia,
    editionStories,
  ]);
  const editionCurrent = editionKey === selectionKey && saveState === 'saved';
  const projectId = project?.id;
  const mediaKey = project?.media.map((m) => m.id).join(',') ?? '';

  const run = useCallback(async (operation: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await operation();
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError')
        setNotice('Операция отменена. Сохраненные данные не изменены.');
      else setError(message(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
      setProgress(null);
      abort.current = null;
    }
  }, []);
  const ask = useCallback(
    (title: string, text: string, action: string, file?: Confirmation['file']) =>
      new Promise<boolean>((resolve) => setConfirmation({ title, text, action, resolve, file })),
    [],
  );
  const closeConfirmation = (result: boolean) => {
    confirmation?.resolve(result);
    setConfirmation(null);
  };
  const guard = async () => {
    if (
      Object.values(drafts).some((d) => d.error) ||
      Object.values(captionDrafts).some((d) => d.error)
    ) {
      if (
        !(await ask(
          'Есть неверно заполненные поля',
          'Исправьте их или отбросьте только неверный ввод. Остальные допустимые изменения будут сохранены.',
          'Отбросить неверный ввод',
        ))
      )
        return false;
      setDrafts({});
      setCaptionDrafts({});
    }
    await flush();
    return true;
  };
  const navigate = (change: () => void) => {
    void run(async () => {
      if (await guard()) change();
    });
  };
  const goToSection = (next: Section) =>
    navigate(() => {
      cardHistory.current = [];
      setSection(next);
      setShowDetail(false);
      setMaterialReturn(null);
    });
  const selectProject = useCallback(
    async (next: FamilyProject) => {
      await open(next);
      const records = getActiveRecords(next);
      setSelectedId(records.people[0]?.id ?? null);
      setTreeRootId(records.people[0]?.id ?? null);
      cardHistory.current = [];
      setShowDetail(false);
      setDialog(null);
      setDrafts({});
      setCaptionDrafts({});
      setEdition('');
      setEditionKey('');
      setEditionIds(records.people.filter((p) => p.lifeStatus === 'deceased').map((p) => p.id));
      setEditionMedia([]);
      setEditionStories([]);
      setFiles([]);
      setFilter('');
      setMaterialReturn(null);
      previousStatuses.current = Object.fromEntries(next.people.map((p) => [p.id, p.lifeStatus]));
      setBackup(await loadBackupStatus(next.id));
    },
    [open],
  );
  useEffect(() => {
    if (!lock.ready) return;
    let valid = true;
    void loadProjects()
      .then(async (list) => {
        if (!valid) return;
        setProjects(list);
        if (list[0]) await selectProject(list[0]);
      })
      .catch((cause: unknown) => {
        if (valid) setError(message(cause));
      })
      .finally(() => {
        if (valid) setLoading(false);
      });
    return () => {
      valid = false;
    };
  }, [lock.ready, selectProject]);
  useEffect(() => {
    if (!lock.owner || loading || !lock.ready) {
      setWriteReady(false);
      return;
    }
    let valid = true;
    void loadProjects()
      .then(async (list) => {
        if (!valid) return;
        setProjects(list);
        const latest = list.find((p) => p.id === current.current?.id) ?? list[0];
        if (latest) {
          await open(latest);
          const records = getActiveRecords(latest);
          setSelectedId((id) =>
            records.people.some((p) => p.id === id) ? id : (records.people[0]?.id ?? null),
          );
          setTreeRootId((id) =>
            records.people.some((p) => p.id === id) ? id : (records.people[0]?.id ?? null),
          );
        }
        if (valid) setWriteReady(true);
      })
      .catch((cause: unknown) => {
        if (valid) setError(message(cause));
      });
    return () => {
      valid = false;
    };
  }, [lock.owner, lock.ready, loading, open, current]);
  useEffect(() => {
    if (!projectId) {
      setFiles([]);
      return;
    }
    if (!lock.ready) return;
    let valid = true;
    void readSnapshot(projectId)
      .then((snapshot) => {
        if (valid) setFiles(snapshot.files);
      })
      .catch((cause: unknown) => {
        if (valid) setError(message(cause));
      });
    return () => {
      valid = false;
    };
  }, [projectId, mediaKey, lock.ready]);
  useEffect(() => {
    if (!project) return;
    const records = getActiveRecords(project);
    setEditionIds((ids) =>
      ids.filter((id) =>
        records.people.some(
          (p) =>
            p.id === id &&
            !(p.lifeStatus !== 'deceased' && previousStatuses.current[id] !== p.lifeStatus),
        ),
      ),
    );
    previousStatuses.current = Object.fromEntries(project.people.map((p) => [p.id, p.lifeStatus]));
  }, [project]);
  useEffect(() => {
    setEditionMedia((ids) => ids.filter((id) => candidates.media.some((m) => m.id === id)));
    setEditionStories((ids) => ids.filter((id) => candidates.stories.some((s) => s.id === id)));
  }, [candidates]);
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    updateService.current = registerSW({
      immediate: true,
      onOfflineReady: () => setOfflineReady(true),
      onNeedRefresh: () => setUpdateReady(true),
      onRegisterError: () =>
        setError('Не удалось подготовить автономный запуск. Повторно откройте приложение с сетью.'),
    });
    const check = async () => {
      const keys = await caches.keys();
      const resources = (
        await Promise.all(
          keys
            .filter((key) => key.includes('workbox-precache'))
            .map(async (key) => (await (await caches.open(key)).keys()).map((r) => r.url)),
        )
      ).flat();
      if (
        resources.some((url) => url.includes('archive.worker')) &&
        resources.some((url) => /elk.*worker/.test(url))
      )
        setOfflineReady(true);
    };
    void navigator.serviceWorker.ready.then(check).catch(() => {});
  }, []);
  useEffect(
    () => () => {
      abort.current?.abort();
    },
    [],
  );
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (Object.keys(drafts).length || Object.keys(captionDrafts).length) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [drafts, captionDrafts]);

  const choosePerson = (id: string) =>
    navigate(() => {
      if (project && (!showDetail || id !== selectedId)) {
        cardHistory.current.push({
          selectedId,
          treeRootId,
          section,
          showDetail,
          query,
          view: viewStates[project.id] ? structuredClone(viewStates[project.id]) : undefined,
        });
      }
      if (project && section === 'people' && id !== treeRootId) {
        setTreeRootId(id);
        setViewStates((views) => ({
          ...views,
          [project.id]: {
            ...(views[project.id] ?? { ancestorDepth: 1, descendantDepth: 1 }),
            viewport: undefined,
            focusId: id,
          },
        }));
      }
      setSelectedId(id);
      setShowDetail(true);
    });
  const backFromCard = () =>
    navigate(() => {
      const context = cardHistory.current.pop();
      if (!context || !project) {
        setShowDetail(false);
        return;
      }
      setSelectedId(context.selectedId);
      setTreeRootId(context.treeRootId);
      setSection(context.section);
      setShowDetail(context.showDetail);
      setQuery(context.query);
      setViewStates((views) => ({
        ...views,
        [project.id]: context.view ?? {
          ancestorDepth: 1,
          descendantDepth: 1,
          focusId: context.treeRootId ?? undefined,
        },
      }));
    });
  const changeField = (field: PersonField, value: string) => {
    if (!person) return;
    const key = `${person.id}:${field}`;
    try {
      edit((draft) => {
        const target = draft.people.find((p) => p.id === person.id)!;
        if (field === 'lifeStatus') target.lifeStatus = value as Person['lifeStatus'];
        else target[field] = value;
      });
      setDrafts((items) => {
        const next = { ...items };
        delete next[key];
        return next;
      });
      if (field === 'lifeStatus')
        setEditionIds((ids) =>
          value === 'deceased'
            ? ids.includes(person.id)
              ? ids
              : [...ids, person.id]
            : ids.filter((id) => id !== person.id),
        );
    } catch (cause) {
      setDrafts((items) => ({ ...items, [key]: { value, error: message(cause) } }));
    }
  };
  const resetField = (field: PersonField) => {
    if (!person) return;
    const saved = store.lastSaved?.people.find((p) => p.id === person.id);
    if (saved) changeField(field, saved[field]);
  };
  const changeCaption = (media: Media, value: string) => {
    try {
      edit((draft) => {
        draft.media.find((m) => m.id === media.id)!.caption = value;
      });
      setCaptionDrafts((items) => {
        const next = { ...items };
        delete next[media.id];
        return next;
      });
    } catch (cause) {
      setCaptionDrafts((items) => ({ ...items, [media.id]: { value, error: message(cause) } }));
    }
  };
  const addFile = (file: File, personId = person?.id) => {
    void run(async () => {
      if (!project || !personId || !(await guard())) return;
      if (protectedMode) throw new Error('Сначала уменьшите объем архива.');
      const prepared = await prepareMedia(file, project.id, [personId]);
      await commit(
        (draft) => {
          draft.media.push(prepared.media);
          const target = draft.people.find((p) => p.id === personId)!;
          if (prepared.media.mime.startsWith('image/') && !target.portraitId)
            target.portraitId = prepared.media.id;
        },
        [prepared.file],
      );
      setNotice('Материал сохранен вместе с оригиналом.');
    });
  };
  const showDialog = (next: Dialog) =>
    navigate(() => {
      setError('');
      setDialog(next);
    });
  const remove = (kind: 'person' | 'relationship' | 'media' | 'story', id: string) => {
    void run(async () => {
      if (!project || !(await guard())) return;
      if (
        !(await ask(
          'Поместить в корзину?',
          kind === 'person'
            ? 'Человек и его активные связи исчезнут из дерева. Общие фотографии и рассказы останутся. Восстановление доступно в разделе «Архив».'
            : 'Запись останется в полной копии. Ее можно вернуть из раздела «Архив» → «Корзина».',
          'В корзину',
        ))
      )
        return;
      await commit(
        (draft) => Object.assign(draft, moveToTrash(draft, kind, id)),
        [],
        kind === 'media' ? { cleanup: { kind: 'trash-media', mediaId: id } } : {},
      );
      if (kind === 'person' && id === selectedId) {
        setSelectedId(null);
        setTreeRootId(getActiveRecords(current.current!).people[0]?.id ?? null);
        cardHistory.current = [];
        setShowDetail(false);
        setNotice('Человек в корзине. Откройте «Архив», чтобы восстановить.');
      } else setNotice('Запись помещена в корзину.');
    });
  };
  const saveBackupMetadata = async (status: BackupStatus) => {
    setBackup(status);
    try {
      await saveBackupStatus(status);
    } catch (cause) {
      setServiceWarning(`Файл выдан. Не удалось сохранить отметку о копии: ${message(cause)}`);
    }
  };
  const exportSnapshot = async (snapshot: ProjectSnapshot, emergencyCopy = false) => {
    const controller = new AbortController();
    abort.current = controller;
    const blob = await exportArchiveInWorker(snapshot, {
      signal: controller.signal,
      onProgress: setProgress,
    });
    setProgress({ stage: 'hashing' });
    const sha256 = await computeArchiveChecksum(blob);
    if (controller.signal.aborted) throw new DOMException('Отменено', 'AbortError');
    abort.current = null;
    download(blob, `rodoslovnaya-${new Date().toISOString().slice(0, 10)}.zip`);
    await saveBackupMetadata({
      projectId: snapshot.project.id,
      revision: snapshot.project.revision,
      createdAt: new Date().toISOString(),
      sha256,
      confirmed: false,
    });
    setNotice(
      emergencyCopy
        ? 'Скачан последний сохраненный снимок. Несохраненный ввод в него не входит. Проверьте файл вне приложения.'
        : 'Файл копии сформирован. Проверьте, куда браузер его сохранил.',
    );
  };
  const backupNow = () => {
    void run(async () => {
      if (!project || !(await guard())) return;
      await exportSnapshot(await readSnapshot(project.id));
    });
  };
  const emergencyNow = () => {
    void run(async () => {
      if (!project) return;
      const snapshot = await readSnapshot(project.id);
      if (calculateCapacity(snapshot.project, snapshot.files).ok)
        await exportSnapshot(snapshot, true);
      else {
        setEmergency(snapshot);
        setNotice('Полная копия недоступна. Можно извлечь отдельные сведения и оригиналы.');
      }
    });
  };
  const extractLocalInput = () => {
    const forms = Array.from(document.querySelectorAll<HTMLFormElement>('dialog[open] form')).map(
      (form) => ({
        title: form.closest('dialog')?.querySelector('h2')?.textContent ?? '',
        fields: Array.from(
          form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
            'input,textarea,select',
          ),
        ).map((field) => ({
          label:
            field.getAttribute('aria-label') ||
            Array.from(field.labels ?? [])
              .map((label) => label.textContent?.trim())
              .join(' ') ||
            field.name,
          value: field.value,
          ...(field instanceof HTMLInputElement && ['checkbox', 'radio'].includes(field.type)
            ? { checked: field.checked }
            : {}),
        })),
      }),
    );
    download(
      new Blob(
        [
          JSON.stringify(
            {
              explanation:
                'Незавершенный ввод из памяти. Это не резервная копия и не файл автоматического восстановления.',
              project: current.current,
              fieldDrafts: drafts,
              captionDrafts,
              forms,
            },
            null,
            2,
          ),
        ],
        { type: 'application/json' },
      ),
      'rodoslovnaya-nezavershennyy-vvod.json',
    );
    setServiceWarning(
      'Незавершенный ввод извлечен из памяти. Это отдельные сведения для ручного восстановления, не полная резервная копия.',
    );
  };
  const restoreFile = (file: File) => {
    void run(async () => {
      if (project && !(await guard())) return;
      const controller = new AbortController();
      abort.current = controller;
      const snapshot = await importArchiveInWorker(file, {
        signal: controller.signal,
        onProgress: setProgress,
      });
      setProgress(null);
      if (
        !(await ask(
          'Восстановить независимый архив?',
          `${snapshot.project.title}. Дата: ${new Date(snapshot.project.updatedAt).toLocaleString('ru-RU')}. Людей: ${snapshot.project.people.length}, материалов: ${snapshot.project.media.length}, оригиналов: ${snapshot.files.length}. Исходные архивы останутся.`,
          'Восстановить',
        ))
      )
        throw new DOMException('Отменено', 'AbortError');
      if (controller.signal.aborted) throw new DOMException('Отменено', 'AbortError');
      setProgress({ stage: 'hashing' });
      const sha256 = await computeArchiveChecksum(file);
      if (controller.signal.aborted) throw new DOMException('Отменено', 'AbortError');
      abort.current = null;
      const restored = await importSnapshot(snapshot);
      try {
        await markBackupVerified(sha256);
      } catch (cause) {
        setServiceWarning(`Архив восстановлен, но отметка проверки не записана: ${message(cause)}`);
      }
      setProjects(await loadProjects());
      await selectProject(restored);
      setSection('tree');
      const records = getActiveRecords(restored);
      const originalBytes = snapshot.files.reduce((total, file) => total + file.original.size, 0);
      setNotice(
        `Целостность копии проверена. Создан независимый архив. Активных людей: ${records.people.length}, связей: ${records.relationships.length}, файловых материалов: ${records.media.length}, рассказов: ${records.stories.length}. Групп в корзине: ${restored.trash.length}. Оригиналов: ${snapshot.files.length}, объем: ${sizeLabel(originalBytes)}. Синхронизации между копиями нет.`,
      );
    });
  };
  const saveRelative = (value: RelativeValue) => {
    void run(async () => {
      if (!person || !dialog || dialog.kind !== 'relative') return;
      const selectedPerson = person;
      const existing = dialog.relationship;
      await commit((draft) => {
        let otherId = value.otherId;
        if (value.mode === 'new') {
          const added = newPerson(value.name);
          draft.people.push(added);
          otherId = added.id;
        }
        const relation: Relationship = {
          id: existing?.id ?? crypto.randomUUID(),
          fromId: value.role === 'parent' ? otherId : selectedPerson.id,
          toId: value.role === 'parent' ? selectedPerson.id : otherId,
          kind: value.role === 'partner' ? 'partner' : value.kind,
          ...(value.role === 'partner' ? { status: value.status } : {}),
        };
        Object.assign(
          draft,
          existing ? updateRelationship(draft, relation) : addRelationship(draft, relation),
        );
      });
      setDialog(null);
      setNotice('Родство сохранено.');
    });
  };
  const saveMaterial = (value: {
    title: string;
    text: string;
    caption: string;
    peopleIds: string[];
  }) => {
    void run(async () => {
      if (!dialog || dialog.kind !== 'material') return;
      await commit((draft) => {
        if (!dialog.entry)
          draft.stories.push({
            id: crypto.randomUUID(),
            title: value.title,
            text: value.text,
            peopleIds: value.peopleIds,
          });
        else {
          Object.assign(
            draft,
            updateMaterialPeople(draft, dialog.type, dialog.entry.id, value.peopleIds),
          );
          if (dialog.type === 'media')
            draft.media.find((m) => m.id === dialog.entry!.id)!.caption = value.caption;
          else {
            const story = draft.stories.find((s) => s.id === dialog.entry!.id)!;
            story.title = value.title;
            story.text = value.text;
          }
        }
      });
      setDialog(null);
      setNotice('Материал сохранен.');
    });
  };
  const restoreGroup = (group: TrashGroup) => {
    void run(async () => {
      await commit((draft) => Object.assign(draft, restoreTrashGroup(draft, group.id)));
      setNotice('Группа восстановлена из корзины.');
    });
  };
  const purge = (media: Media) => {
    void run(async () => {
      const file = files.find((f) => f.id === media.id);
      if (
        !(await ask(
          'Удалить файл навсегда?',
          `${media.caption || media.name}. Размер: ${sizeLabel(media.size)}. Участники: ${media.peopleIds.map((id) => project?.people.find((p) => p.id === id)?.name).join(', ') || 'нет'}. Оригинал, уменьшенная копия и портретные ссылки будут удалены без возможности восстановления.`,
          'Удалить навсегда',
          file ? { blob: file.original, name: media.name } : undefined,
        ))
      )
        return;
      await commit((draft) => Object.assign(draft, purgeMedia(draft, media.id)), [], {
        cleanup: { kind: 'purge-media', mediaId: media.id },
      });
      setNotice('Выбранный файл удален навсегда.');
    });
  };
  if ((loading || !lock.ready) && !project)
    return (
      <main className="loading">
        <h1>Родословная</h1>
        <p>
          {lock.upgradePending
            ? 'Для обновления базы сохраните изменения и закройте старые окна приложения'
            : 'Открываем семейный архив…'}
        </p>
        {(error || lock.error) && <p role="alert">{error || lock.error}</p>}
        {lock.unsupported && (
          <p>Для безопасной записи нужен современный Chrome, Edge или Safari.</p>
        )}
      </main>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => goToSection('tree')}>
          <img src="/icon.svg" alt="" width="42" height="42" />
          <span>
            Родословная<small>Личный семейный архив</small>
          </span>
        </button>
        <nav aria-label="Основные разделы">
          {sections.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${section === item.id ? 'active' : ''}`}
              aria-current={section === item.id ? 'page' : undefined}
              onClick={() => goToSection(item.id)}
            >
              <span aria-hidden="true">{item.icon}</span>
              {item.name}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="privacy-dot" />
          Данные на этом устройстве
          <p>
            Без регистрации.
            <br />
            Внешняя копия защищает от потери.
          </p>
          <button className="text-button" onClick={() => goToSection('archive')}>
            Сохранить копию
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">СЕМЕЙНАЯ ПАМЯТЬ</span>
            <h1>{project?.title ?? 'Ваша история начинается здесь'}</h1>
          </div>
          {project && (
            <div className="topbar-actions">
              <span className={`save-indicator ${saveState}`} role="status">
                {busy
                  ? 'Выполняется…'
                  : Object.keys(drafts).length || Object.keys(captionDrafts).length
                    ? 'Есть неверно заполненные поля'
                    : saveState === 'saved'
                      ? 'Сохранено в приложении'
                      : saveState === 'saving'
                        ? 'Сохраняется…'
                        : saveState === 'dirty'
                          ? 'Есть изменения'
                          : 'Ошибка сохранения'}
              </span>
              <button
                className="primary"
                disabled={disabled || protectedMode}
                onClick={() => showDialog({ kind: 'person' })}
              >
                + Добавить человека
              </button>
            </div>
          )}
        </header>
        <div className="messages" aria-live="polite">
          {!lock.owner && (
            <p className="banner warning">
              {lock.unsupported
                ? 'Браузер не поддерживает безопасную блокировку. Используйте современный Chrome, Edge или Safari.'
                : 'Режим чтения. Закройте другое окно приложения, чтобы редактировать здесь.'}
            </p>
          )}
          {(error || saveError || lock.error) && (
            <div className="banner error" role="alert">
              {error || saveError || lock.error}
              {saveError && (
                <button disabled={busy} onClick={() => void run(flush)}>
                  Повторить сохранение
                </button>
              )}
              {project && (
                <button disabled={busy} onClick={emergencyNow}>
                  Скачать сохраненные данные
                </button>
              )}
              {project && <button onClick={extractLocalInput}>Скачать незавершенный ввод</button>}
            </div>
          )}
          {notice && <p className="banner success">{notice}</p>}
          {serviceWarning && (
            <div className="banner warning" role="alert">
              {serviceWarning}
              <button onClick={() => setServiceWarning('')}>Закрыть сообщение</button>
            </div>
          )}
          {protectedMode && (
            <div className="banner warning">
              Защитный режим: {capacity?.violations.map((key) => CAPACITY_MESSAGES[key]).join(' ')}{' '}
              Удаление в корзину не освобождает место. Скачайте сохраненные данные, затем сократите
              текст или окончательно удалите выбранный файл.
              <button disabled={busy} onClick={emergencyNow}>
                Извлечь сведения и оригиналы
              </button>
            </div>
          )}
          {progress && (
            <div className="banner" role="status">
              {progressLabels[progress.stage]}
              {progress.completed !== undefined && progress.total !== undefined
                ? `: ${progress.completed} из ${progress.total}`
                : '…'}
              <button onClick={() => abort.current?.abort()} disabled={!abort.current}>
                Отменить операцию
              </button>
            </div>
          )}
          {updateReady && (
            <div className="banner">
              Доступна новая версия.
              <button
                disabled={disabled}
                onClick={() =>
                  void run(async () => {
                    if (await guard()) await updateService.current?.(true);
                  })
                }
              >
                Сохранить и обновить
              </button>
            </div>
          )}
        </div>
        {!project ? (
          <main className="welcome">
            <div className="welcome-mark" aria-hidden="true">
              ♧
            </div>
            <span className="eyebrow">ВАША СЕМЬЯ НАЧИНАЕТСЯ С ИМЕНИ</span>
            <h2>С кого начнем?</h2>
            <p>
              Можно начать с себя или любого родственника.
              <br />
              Достаточно имени. Остальное добавите позже.
            </p>
            <form
              className="start-form"
              onSubmit={(event) => {
                event.preventDefault();
                const name = String(new FormData(event.currentTarget).get('name')).trim();
                void run(async () => {
                  const created = await createProject('Моя семья', name);
                  setProjects(await loadProjects());
                  await selectProject(created);
                  setShowDetail(true);
                });
              }}
            >
              <label className="sr-only" htmlFor="first-person">
                Имя первого человека
              </label>
              <input
                id="first-person"
                name="name"
                required
                maxLength={200}
                placeholder="Например, Анна Иванова"
              />
              <button className="primary" disabled={disabled}>
                Начать семейный архив
              </button>
            </form>
            <p className="muted">Название архива «Моя семья» можно изменить.</p>
            <label className={`text-button restore-link ${disabled ? 'disabled' : ''}`}>
              У меня уже есть резервная копия
              <input
                aria-label="У меня уже есть резервная копия"
                type="file"
                className="sr-only"
                accept=".zip,application/zip"
                disabled={disabled}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) restoreFile(file);
                }}
              />
            </label>
          </main>
        ) : (
          <>
            <div className="project-strip">
              <span>
                Людей: {active?.people.length} · Материалов: {active?.media.length} · Историй:{' '}
                {active?.stories.length}
              </span>
              <span className="offline-status">
                {offlineReady
                  ? '● Доступно без интернета'
                  : import.meta.env.DEV
                    ? 'Версия для разработки'
                    : 'Подготовка автономной работы…'}
              </span>
            </div>
            <div
              className={`work-layout ${showDetail && person ? 'detail-open' : ''} ${section !== 'tree' && section !== 'people' ? 'section-hidden' : ''}`}
            >
              <section className="main-stage">
                <div className="section-heading">
                  <div>
                    <span className="eyebrow">ПОКОЛЕНИЯ И СВЯЗИ</span>
                    <h2>{section === 'people' ? 'Люди в вашей истории' : 'Семейное дерево'}</h2>
                  </div>
                  {section === 'people' && (
                    <label className="search">
                      <span aria-hidden="true">⌕</span>
                      <input
                        type="search"
                        value={query}
                        placeholder="Найти человека"
                        aria-label="Поиск людей"
                        onChange={(event) => setQuery(event.target.value)}
                      />
                    </label>
                  )}
                </div>
                {!active?.people.length ? (
                  <div className="empty-state">
                    <span className="empty-symbol">♧</span>
                    <h3>Начните с одного человека</h3>
                    <p>
                      Можно добавить любого родственника или вернуть человека из корзины в разделе
                      «Архив».
                    </p>
                    <button
                      disabled={disabled || protectedMode}
                      onClick={() => showDialog({ kind: 'person' })}
                    >
                      Добавить первого человека
                    </button>
                  </div>
                ) : (
                  <>
                    <div hidden={section !== 'tree'}>
                      <Suspense fallback={<p className="loading">Открываем дерево…</p>}>
                        <FamilyTree
                          key={project.id}
                          project={project}
                          selectedId={treeRootId ?? active.people[0].id}
                          onSelect={choosePerson}
                          viewState={viewStates[project.id]}
                          onViewStateChange={(value) =>
                            setViewStates((items) => ({ ...items, [project.id]: value }))
                          }
                        />
                      </Suspense>
                    </div>
                    {section === 'people' && (
                      <div className="people-list">
                        {active.people
                          .filter((p) =>
                            p.name.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')),
                          )
                          .map((p) => (
                            <button
                              className={`person-row ${p.id === selectedId ? 'selected' : ''}`}
                              key={p.id}
                              onClick={() => choosePerson(p.id)}
                            >
                              <span className="avatar" aria-hidden="true">
                                {initials(p.name)}
                              </span>
                              <span>
                                <strong>{p.name}</strong>
                                <small>
                                  {p.birthDate
                                    ? dateLabel(p.birthDate)
                                    : statusLabels[p.lifeStatus]}
                                </small>
                              </span>
                              <span className="row-arrow" aria-hidden="true">
                                →
                              </span>
                            </button>
                          ))}
                        {!active.people.some((p) =>
                          p.name.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')),
                        ) && <p>Никого не найдено. Измените имя в поиске.</p>}
                      </div>
                    )}
                  </>
                )}
              </section>
              {person && (section === 'tree' || section === 'people') ? (
                <PersonEditor
                  project={project}
                  person={person}
                  urls={urls}
                  disabled={disabled}
                  drafts={drafts}
                  onField={changeField}
                  onReset={resetField}
                  onBack={backFromCard}
                  onRelative={() => showDialog({ kind: 'relative' })}
                  onFile={addFile}
                  onStory={() =>
                    showDialog({ kind: 'material', type: 'story', personId: person.id })
                  }
                  onMaterials={() =>
                    navigate(() => {
                      setMaterialReturn(section);
                      setFilter(person.id);
                      setSection('materials');
                    })
                  }
                  onDelete={() => remove('person', person.id)}
                  onSelect={choosePerson}
                  onRelation={(relationship) => showDialog({ kind: 'relative', relationship })}
                  onDeleteRelation={(relationship) => remove('relationship', relationship.id)}
                  onPortrait={(id) =>
                    void run(async () => {
                      if (await guard())
                        await commit((draft) =>
                          Object.assign(draft, setPortrait(draft, person.id, id)),
                        );
                    })
                  }
                />
              ) : (
                <aside className="person-panel empty-panel">
                  <p>Выберите человека, чтобы открыть его карточку.</p>
                </aside>
              )}
            </div>
            {section === 'materials' && (
              <MaterialsView
                project={project}
                filter={filter}
                onFilter={(id) => navigate(() => setFilter(id))}
                urls={urls}
                disabled={disabled}
                onFile={addFile}
                onStory={(personId) => showDialog({ kind: 'material', type: 'story', personId })}
                onEdit={(type, entry) => showDialog({ kind: 'material', type, entry })}
                onDelete={remove}
                onOpen={(media) => showDialog({ kind: 'view', media })}
                onCaption={changeCaption}
                captionDrafts={captionDrafts}
                onResetCaption={(id) => {
                  const saved = store.lastSaved?.media.find((m) => m.id === id);
                  const media = project.media.find((m) => m.id === id);
                  if (saved && media) changeCaption(media, saved.caption);
                }}
                onBack={
                  materialReturn
                    ? () =>
                        navigate(() => {
                          setSection(materialReturn);
                          setMaterialReturn(null);
                          setShowDetail(true);
                        })
                    : undefined
                }
              />
            )}
            {section === 'archive' && (
              <ArchiveView
                project={project}
                projects={projects}
                disabled={disabled}
                busy={busy}
                onProject={(id) =>
                  void run(async () => {
                    if (!(await guard())) return;
                    const next = (await loadProjects()).find((p) => p.id === id);
                    if (next) await selectProject(next);
                  })
                }
                onRename={() => showDialog({ kind: 'rename' })}
                backup={backup}
                onConfirmBackup={(confirmed) =>
                  void run(async () => {
                    if (backup) await saveBackupMetadata({ ...backup, confirmed });
                  })
                }
                onBackup={backupNow}
                onEmergency={emergencyNow}
                onImport={restoreFile}
                onPersist={() =>
                  void run(async () => {
                    const granted = await navigator.storage?.persist?.();
                    setNotice(
                      granted
                        ? 'Устойчивое хранение предоставлено. Внешняя копия по-прежнему необходима.'
                        : 'Браузер не предоставил устойчивое хранение. Сохраняйте внешние копии.',
                    );
                  })
                }
                protectedMode={protectedMode}
                onRestore={restoreGroup}
                onPurge={purge}
                onShorten={(group) => showDialog({ kind: 'shorten', group })}
                peopleIds={editionIds}
                mediaIds={editionMedia}
                storyIds={editionStories}
                onPeople={setEditionIds}
                onMedia={setEditionMedia}
                onStories={setEditionStories}
                candidates={candidates}
                onEditMaterial={(type, entry) => showDialog({ kind: 'material', type, entry })}
                edition={edition}
                editionCurrent={editionCurrent}
                onPreview={() =>
                  void run(async () => {
                    if (!(await guard())) return;
                    const snapshot = await readSnapshot(project.id);
                    const html = await createEdition(snapshot, editionIds, {
                      mediaIds: editionMedia,
                      storyIds: editionStories,
                    });
                    setEdition(html);
                    setEditionKey(
                      JSON.stringify([
                        snapshot.project.id,
                        snapshot.project.revision,
                        editionIds,
                        editionMedia,
                        editionStories,
                      ]),
                    );
                  })
                }
                onEditionDownload={() =>
                  download(
                    new Blob([edition], { type: 'text/html;charset=utf-8' }),
                    'semeynaya-istoriya.html',
                  )
                }
              />
            )}
          </>
        )}
        <footer className="app-footer">
          <span>РОДОСЛОВНАЯ</span>
          <span>Личный архив · локальная проверка</span>
        </footer>
      </div>
      {dialog && (
        <Modal
          title={
            dialog.kind === 'person'
              ? 'Добавить человека'
              : dialog.kind === 'rename'
                ? 'Название архива'
                : dialog.kind === 'relative'
                  ? dialog.relationship
                    ? 'Изменить родство'
                    : 'Добавить родственника'
                  : dialog.kind === 'view'
                    ? dialog.media.caption || dialog.media.name
                    : dialog.kind === 'shorten'
                      ? 'Сократить сохраненный текст'
                      : dialog.type === 'story'
                        ? dialog.entry
                          ? 'Изменить историю'
                          : 'Написать историю'
                        : 'Изменить материал'
          }
          busy={busy}
          error={error || saveError || lock.error}
          errorAction={
            project && (
              <>
                <button disabled={busy} onClick={emergencyNow}>
                  Скачать сохраненные данные
                </button>
                <button onClick={extractLocalInput}>Скачать незавершенный ввод</button>
              </>
            )
          }
          operation={
            progress && (
              <div className="banner" role="status">
                {progressLabels[progress.stage]}
                {progress.completed !== undefined && progress.total !== undefined
                  ? `: ${progress.completed} из ${progress.total}`
                  : '…'}
                <button onClick={() => abort.current?.abort()} disabled={!abort.current}>
                  Отменить операцию
                </button>
              </div>
            )
          }
          onClose={() => {
            setDialog(null);
            setError('');
          }}
        >
          {dialog.kind === 'person' && (
            <NameForm
              disabled={disabled || protectedMode}
              onSave={(name) =>
                void run(async () => {
                  const origin: CardContext = {
                    selectedId,
                    treeRootId,
                    section,
                    showDetail,
                    query,
                    view:
                      project && viewStates[project.id]
                        ? structuredClone(viewStates[project.id])
                        : undefined,
                  };
                  const added = newPerson(name);
                  await commit((draft) => {
                    draft.people.push(added);
                  });
                  setSelectedId(added.id);
                  setTreeRootId(added.id);
                  cardHistory.current.push(origin);
                  setShowDetail(true);
                  setDialog(null);
                })
              }
            />
          )}
          {dialog.kind === 'rename' && project && (
            <NameForm
              label="Название семейного архива"
              initial={project.title}
              disabled={disabled}
              onSave={(name) =>
                void run(async () => {
                  await commit((draft) => {
                    draft.title = name;
                  });
                  setDialog(null);
                })
              }
            />
          )}
          {dialog.kind === 'relative' && project && person && (
            <RelativeForm
              project={project}
              person={person}
              relationship={dialog.relationship}
              disabled={disabled || protectedMode}
              onSave={saveRelative}
            />
          )}
          {dialog.kind === 'material' && project && (
            <MaterialForm
              project={project}
              entry={dialog.entry}
              personId={dialog.personId}
              disabled={disabled || (protectedMode && !dialog.entry)}
              onSave={saveMaterial}
            />
          )}
          {dialog.kind === 'view' && (
            <>
              <p className="muted">
                Оригинал: {sizeLabel(dialog.media.size)}. Документ PDF можно скачать и открыть из
                файлов устройства.
              </p>
              {dialog.media.mime.startsWith('image/') && originalUrls[dialog.media.id] && (
                <img
                  className="full-photo"
                  src={originalUrls[dialog.media.id]}
                  alt={dialog.media.caption || 'Семейная фотография'}
                />
              )}
              {dialog.media.mime === 'application/pdf' && originalUrls[dialog.media.id] && (
                <a
                  className="button"
                  href={originalUrls[dialog.media.id]}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Открыть PDF
                </a>
              )}
              <button
                onClick={() => {
                  const file = files.find((f) => f.id === dialog.media.id);
                  if (file) download(file.original, dialog.media.name);
                }}
              >
                Скачать оригинал
              </button>
            </>
          )}
          {dialog.kind === 'shorten' && project && (
            <ShortenForm
              project={project}
              group={dialog.group}
              disabled={disabled}
              onSave={(field, value) =>
                void run(async () => {
                  await commit((draft) => {
                    const target =
                      dialog.group.kind === 'person'
                        ? draft.people.find((p) => p.id === dialog.group.entityId)
                        : dialog.group.kind === 'story'
                          ? draft.stories.find((s) => s.id === dialog.group.entityId)
                          : dialog.group.kind === 'media'
                            ? draft.media.find((m) => m.id === dialog.group.entityId)
                            : undefined;
                    if (target) Object.assign(target, { [field]: value });
                  });
                  setDialog(null);
                })
              }
            />
          )}
        </Modal>
      )}
      {confirmation && (
        <Modal title={confirmation.title} onClose={() => closeConfirmation(false)}>
          <p>{confirmation.text}</p>
          {confirmation.file && (
            <button onClick={() => download(confirmation.file!.blob, confirmation.file!.name)}>
              Скачать оригинал перед удалением
            </button>
          )}
          <div className="dialog-actions">
            <button onClick={() => closeConfirmation(false)}>Отмена</button>
            <button className="primary" onClick={() => closeConfirmation(true)}>
              {confirmation.action}
            </button>
          </div>
        </Modal>
      )}
      {emergency && (
        <Modal title="Извлечь сохраненные сведения" onClose={() => setEmergency(null)}>
          <EmergencyFiles
            project={emergency.project}
            files={emergency.files}
            onDownload={download}
          />
        </Modal>
      )}
    </div>
  );
}

function ShortenForm({
  project,
  group,
  disabled,
  onSave,
}: {
  project: FamilyProject;
  group: TrashGroup;
  disabled: boolean;
  onSave: (field: string, value: string) => void;
}) {
  const target =
    group.kind === 'person'
      ? project.people.find((p) => p.id === group.entityId)
      : group.kind === 'story'
        ? project.stories.find((s) => s.id === group.entityId)
        : group.kind === 'media'
          ? project.media.find((m) => m.id === group.entityId)
          : undefined;
  const fields =
    group.kind === 'person'
      ? ['name', 'birthPlace', 'biography', 'source']
      : group.kind === 'story'
        ? ['title', 'text']
        : group.kind === 'media'
          ? ['caption']
          : [];
  const labels: Record<string, string> = {
    name: 'Имя',
    birthPlace: 'Место рождения',
    biography: 'Биография',
    source: 'Источник',
    title: 'Название',
    text: 'Рассказ',
    caption: 'Подпись',
  };
  const [field, setField] = useState(fields[0] ?? '');
  const values = target as unknown as Record<string, string> | undefined;
  const [value, setValue] = useState(values?.[field] ?? '');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave(field, value);
      }}
    >
      <fieldset disabled={disabled} className="form-stack">
        <p>Запись останется в корзине. Сначала сохраните исходный текст вне приложения.</p>
        <label>
          Поле
          <select
            value={field}
            onChange={(event) => {
              setField(event.target.value);
              setValue(values?.[event.target.value] ?? '');
            }}
          >
            {fields.map((key) => (
              <option key={key} value={key}>
                {labels[key]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() =>
            download(
              new Blob([values?.[field] ?? ''], { type: 'text/plain;charset=utf-8' }),
              'rodoslovnaya-tekst.txt',
            )
          }
        >
          Скачать исходный текст
        </button>
        <label>
          Сокращенный текст
          <textarea value={value} onChange={(event) => setValue(event.target.value)} rows={8} />
        </label>
        <button className="primary" disabled={!fields.length}>
          Сохранить сокращение
        </button>
      </fieldset>
    </form>
  );
}
