import Dexie, { type Table } from 'dexie';
import {
  migrateLegacyProject,
  newProject,
  purgeMedia,
  validateProject,
  ValidationError,
} from '../domain/model';
import {
  newPerson,
  type BackupStatus,
  type FamilyProject,
  type ProjectSnapshot,
  type StoredFile,
} from '../domain/types';
import { calculateCapacity, canReduceCapacity, CapacityError } from '../domain/capacity';
export type { BackupStatus } from '../domain/types';

export const DATABASE_VERSION = 2;
const databaseListeners = new Set<() => void>();
let databaseChanged = false;
let databaseBlocked = false;

export function subscribeDatabaseState(listener: () => void): () => void {
  databaseListeners.add(listener);
  return () => {
    databaseListeners.delete(listener);
  };
}

export function getDatabaseState() {
  return { changed: databaseChanged, blocked: databaseBlocked };
}

function publishDatabaseState() {
  for (const listener of databaseListeners) listener();
}

class FamilyDatabase extends Dexie {
  projects!: Table<FamilyProject, string>;
  files!: Table<StoredFile, [string, string]>;
  backupStatus!: Table<BackupStatus, string>;

  constructor() {
    super('Rodoslovnaya', { autoOpen: false });
    this.version(1).stores({ projects: 'id,updatedAt', files: '[projectId+id],projectId' });
    this.version(2)
      .stores({
        projects: 'id,updatedAt',
        files: '[projectId+id],projectId',
        backupStatus: 'projectId,sha256',
      })
      .upgrade(async (transaction) => {
        await transaction
          .table('projects')
          .toCollection()
          .modify((project) => {
            Object.assign(project, migrateLegacyProject(project));
          });
      });
    this.on('versionchange', () => {
      databaseChanged = true;
      this.close({ disableAutoOpen: true });
      publishDatabaseState();
    });
    this.on('blocked', () => {
      databaseBlocked = true;
      publishDatabaseState();
    });
  }
}

export const db = new FamilyDatabase();

async function existingDatabaseVersion(): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    let missing = false;
    const request = indexedDB.open('Rodoslovnaya');
    request.onupgradeneeded = () => {
      missing = true;
      request.transaction!.abort();
    };
    request.onerror = () => (missing ? resolve(undefined) : reject(request.error));
    request.onsuccess = () => {
      const version = request.result.version;
      request.result.close();
      resolve(version);
    };
  });
}

export async function prepareDatabase(allowUpgrade: boolean): Promise<boolean> {
  if (databaseChanged)
    throw new Error(
      'Структура базы изменилась. Скопируйте незавершенный ввод и обновите приложение.',
    );
  if (db.isOpen()) return true;
  const version = await existingDatabaseVersion();
  if (version !== undefined && version > DATABASE_VERSION * 10)
    throw new Error('База создана более новой версией приложения. Обновите приложение.');
  if (!allowUpgrade && (version === undefined || version < DATABASE_VERSION * 10)) return false;
  await db.open();
  if (db.backendDB().version !== DATABASE_VERSION * 10) {
    db.close({ disableAutoOpen: true });
    throw new Error('Версия базы не соответствует приложению. Обновите приложение.');
  }
  databaseBlocked = false;
  publishDatabaseState();
  return true;
}

export class ConflictError extends Error {
  constructor() {
    super('Проект изменился в другом окне. Загрузите актуальную версию перед продолжением.');
    this.name = 'ConflictError';
  }
}

export class ProjectNotFoundError extends Error {
  constructor() {
    super('Проект не найден.');
    this.name = 'ProjectNotFoundError';
  }
}

function validateFiles(project: FamilyProject, files: StoredFile[]): void {
  if (!Array.isArray(files)) throw new ValidationError('Ожидается список файлов.');
  const materials = new Map(project.media.map((material) => [material.id, material]));
  const seen = new Set<string>();
  for (const file of files) {
    if (
      typeof file !== 'object' ||
      file === null ||
      !Object.keys(file).every((key) => ['id', 'projectId', 'original', 'thumbnail'].includes(key))
    ) {
      throw new ValidationError('Неверное описание файла.');
    }
    const material = materials.get(file.id);
    if (!material || file.projectId !== project.id || seen.has(file.id))
      throw new ValidationError('Файл не соответствует составу проекта.');
    if (
      !(file.original instanceof Blob) ||
      file.original.size !== material.size ||
      (file.original.type !== '' && file.original.type !== material.mime)
    ) {
      throw new ValidationError('Размер или формат оригинала не совпадает с описанием материала.');
    }
    if (
      file.thumbnail !== undefined &&
      (!(file.thumbnail instanceof Blob) ||
        !['image/jpeg', 'image/png', 'image/webp'].includes(file.thumbnail.type))
    ) {
      throw new ValidationError('Неверный формат уменьшенного изображения.');
    }
    seen.add(file.id);
  }
  if (seen.size !== materials.size)
    throw new ValidationError('В проекте отсутствует оригинал материала.');
}

export async function loadProjects(): Promise<FamilyProject[]> {
  const projects = await db.projects.toArray();
  for (const project of projects) validateProject(project);
  return projects.sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
}

export async function loadProject(id: string): Promise<FamilyProject | undefined> {
  const project = await db.projects.get(id);
  if (project !== undefined) validateProject(project);
  return project;
}

export async function createProject(title: string, firstName?: string): Promise<FamilyProject> {
  const project = newProject(title);
  if (firstName !== undefined) project.people.push(newPerson(firstName));
  validateProject(project);
  const report = calculateCapacity(project, []);
  if (!report.ok) throw new CapacityError(report);
  await db.projects.add(project);
  return project;
}

export async function saveProject(
  project: FamilyProject,
  expectedRevision: number,
  filesToAdd: StoredFile[] = [],
  options: SaveOptions = {},
): Promise<FamilyProject> {
  validateProject(project);
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    project.revision !== expectedRevision
  )
    throw new ConflictError();
  if (!Array.isArray(filesToAdd)) throw new ValidationError('Ожидается список добавляемых файлов.');
  const candidate = structuredClone(project);
  const additions = structuredClone(filesToAdd);
  const before = await readSnapshot(candidate.id);
  if (before.project.revision !== expectedRevision) throw new ConflictError();
  if (before.project.createdAt !== candidate.createdAt)
    throw new ValidationError('Дата создания проекта не может изменяться.');
  const retained = new Set(candidate.media.map((item) => item.id));
  const combined = new Map(
    before.files.filter((file) => retained.has(file.id)).map((file) => [file.id, file]),
  );
  for (const file of additions) {
    if (typeof file !== 'object' || file === null || combined.has(file.id))
      throw new ValidationError(
        'Нельзя перезаписать существующий оригинал под тем же идентификатором.',
      );
    combined.set(file.id, file);
  }
  validateFiles(candidate, [...combined.values()]);
  const next: FamilyProject = {
    ...candidate,
    revision: expectedRevision + 1,
    updatedAt: new Date(
      Math.max(
        Date.now(),
        Date.parse(before.project.updatedAt),
        Date.parse(before.project.createdAt),
      ),
    ).toISOString(),
  };
  validateProject(next);
  const currentCapacity = calculateCapacity(before.project, before.files);
  const nextCapacity = calculateCapacity(next, [...combined.values()]);
  const cleanup = cleanupKind(before.project, candidate, options);
  if (!nextCapacity.ok || !currentCapacity.ok) {
    if (cleanup === 'trash-media') {
      if (currentCapacity.ok) {
        const backup = await loadBackupStatus(candidate.id);
        if (!backup || backup.revision !== expectedRevision || !backup.confirmed)
          throw new ValidationError(
            'Сначала сохраните внешнюю полную копию текущей ревизии и подтвердите сохранение файла.',
          );
      }
    } else if (
      cleanup !== 'purge-media' &&
      !(
        isTextReduction(before.project, candidate) &&
        (nextCapacity.ok || canReduceCapacity(currentCapacity, nextCapacity))
      )
    ) {
      if (nextCapacity.ok)
        throw new ValidationError(
          'В защитном режиме доступны сокращение текстов и очистка выбранного материала.',
        );
      throw new CapacityError(nextCapacity);
    }
  }
  return db.transaction('rw', db.projects, db.files, db.backupStatus, async () => {
    const current = await db.projects.get(candidate.id);
    if (!current) throw new ProjectNotFoundError();
    validateProject(current);
    if (current.revision !== expectedRevision) throw new ConflictError();
    if (cleanup === 'trash-media' && currentCapacity.ok && !nextCapacity.ok) {
      const backup = await db.backupStatus.get(candidate.id);
      if (!backup || backup.revision !== expectedRevision || !backup.confirmed)
        throw new ValidationError(
          'Подтвержденная копия текущей ревизии не найдена. Сначала сохраните внешний файл.',
        );
    }
    if (current.createdAt !== candidate.createdAt)
      throw new ValidationError('Дата создания проекта не может изменяться.');
    const existing = await db.files.where('projectId').equals(candidate.id).toArray();
    const retainedIds = new Set(candidate.media.map((material) => material.id));
    const combined = new Map(
      existing.filter((file) => retainedIds.has(file.id)).map((file) => [file.id, file]),
    );
    for (const file of additions) {
      if (typeof file !== 'object' || file === null || combined.has(file.id))
        throw new ValidationError(
          'Нельзя перезаписать существующий оригинал под тем же идентификатором.',
        );
      combined.set(file.id, file);
    }
    validateFiles(candidate, [...combined.values()]);
    if (additions.length) await db.files.bulkAdd(additions);
    const removed = existing
      .filter((file) => !retainedIds.has(file.id))
      .map((file): [string, string] => [file.projectId, file.id]);
    if (removed.length) await db.files.bulkDelete(removed);
    await db.projects.put(next);
    return next;
  });
}

export async function readSnapshot(id: string): Promise<ProjectSnapshot> {
  return db.transaction('r', db.projects, db.files, async () => {
    const project = await db.projects.get(id);
    if (!project) throw new ProjectNotFoundError();
    validateProject(project);
    const files = await db.files.where('projectId').equals(id).toArray();
    validateFiles(project, files);
    return { project, files };
  });
}

export async function importSnapshot(snapshot: ProjectSnapshot): Promise<FamilyProject> {
  if (
    typeof snapshot !== 'object' ||
    snapshot === null ||
    !Object.keys(snapshot).every((key) => ['project', 'files'].includes(key))
  )
    throw new ValidationError('Неверный состав резервной копии.');
  validateProject(snapshot.project);
  validateFiles(snapshot.project, snapshot.files);
  const source = structuredClone(snapshot);
  const sourceCapacity = calculateCapacity(source.project, source.files);
  if (!sourceCapacity.ok) {
    const { trash, ...legacy } = source.project;
    if (trash.length > 0 || !calculateCapacity(legacy, source.files, 1).ok)
      throw new CapacityError(sourceCapacity);
  }
  const now = new Date().toISOString();
  const project: FamilyProject = {
    ...source.project,
    id: crypto.randomUUID(),
    revision: 0,
    createdAt: now,
    updatedAt: now,
    restoredFrom: { projectId: source.project.id, createdAt: source.project.updatedAt },
  };
  const files = source.files.map((file) => ({ ...file, projectId: project.id }));
  validateProject(project);
  validateFiles(project, files);
  await db.transaction('rw', db.projects, db.files, async () => {
    await db.projects.add(project);
    if (files.length) await db.files.bulkAdd(files);
  });
  return project;
}

export interface SaveOptions {
  cleanup?: { kind: 'trash-media' | 'purge-media'; mediaId: string };
}

function cleanupKind(
  current: FamilyProject,
  candidate: FamilyProject,
  options: SaveOptions,
): 'trash-media' | 'purge-media' | undefined {
  const cleanup = options.cleanup;
  if (!cleanup) return undefined;
  if (cleanup.kind === 'purge-media') {
    if (JSON.stringify(purgeMedia(current, cleanup.mediaId)) !== JSON.stringify(candidate))
      throw new ValidationError(
        'Очистка должна изменять только выбранный материал и его портретные ссылки.',
      );
  } else {
    const added = candidate.trash.filter(
      (group) => !current.trash.some((item) => item.id === group.id),
    );
    const group = added[0];
    const comparable = {
      ...candidate,
      trash: candidate.trash.filter((item) => item.id !== group?.id),
    };
    if (
      added.length !== 1 ||
      group.kind !== 'media' ||
      group.entityId !== cleanup.mediaId ||
      group.relationshipIds.length ||
      JSON.stringify(comparable) !== JSON.stringify(current)
    )
      throw new ValidationError(
        'Подготовка очистки должна помещать в корзину только выбранный материал.',
      );
  }
  return cleanup.kind;
}

function isTextReduction(current: FamilyProject, candidate: FamilyProject): boolean {
  const restored = structuredClone(candidate);
  let reduced = false;
  const encoder = new TextEncoder();
  const restoreText = (
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    keys: string[],
  ) => {
    for (const key of keys) {
      const oldValue = before[key];
      const newValue = after[key];
      if (oldValue === newValue) continue;
      if (
        typeof oldValue !== 'string' ||
        typeof newValue !== 'string' ||
        encoder.encode(newValue).length > encoder.encode(oldValue).length
      )
        return false;
      reduced ||= encoder.encode(newValue).length < encoder.encode(oldValue).length;
      after[key] = oldValue;
    }
    return true;
  };
  if (
    !restoreText(
      current as unknown as Record<string, unknown>,
      restored as unknown as Record<string, unknown>,
      ['title'],
    )
  )
    return false;
  for (const [collection, fields] of [
    ['people', ['name', 'birthDate', 'deathDate', 'birthPlace', 'biography', 'source']],
    ['media', ['name', 'caption']],
    ['stories', ['title', 'text']],
  ] as const) {
    if (current[collection].length !== restored[collection].length) return false;
    for (let index = 0; index < current[collection].length; index++) {
      if (
        !restoreText(
          current[collection][index] as unknown as Record<string, unknown>,
          restored[collection][index] as unknown as Record<string, unknown>,
          [...fields],
        )
      )
        return false;
    }
  }
  return reduced && JSON.stringify(restored) === JSON.stringify(current);
}

export async function loadBackupStatus(projectId: string): Promise<BackupStatus | undefined> {
  return db.backupStatus.get(projectId);
}

export async function saveBackupStatus(status: BackupStatus): Promise<void> {
  if (
    !Number.isSafeInteger(status.revision) ||
    status.revision < 0 ||
    !/^[a-f0-9]{64}$/.test(status.sha256) ||
    typeof status.confirmed !== 'boolean' ||
    !Number.isFinite(Date.parse(status.createdAt)) ||
    (status.verifiedAt !== undefined && !Number.isFinite(Date.parse(status.verifiedAt)))
  )
    throw new ValidationError('Неверная отметка резервной копии.');
  const project = await loadProject(status.projectId);
  if (!project || status.revision > project.revision)
    throw new ValidationError('Отметка копии не соответствует архиву.');
  await db.backupStatus.put(structuredClone(status));
}

export async function markBackupVerified(sha256: string): Promise<void> {
  await db.backupStatus
    .where('sha256')
    .equals(sha256)
    .modify({ verifiedAt: new Date().toISOString() });
}
