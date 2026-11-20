import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as capacity from '../domain/capacity';
import {
  addRelationship,
  getActivePeople,
  moveToTrash,
  newProject,
  purgeMedia,
  restoreTrashGroup,
} from '../domain/model';
import { newPerson, type FamilyProject } from '../domain/types';
import {
  createProject,
  db,
  importSnapshot,
  loadBackupStatus,
  loadProject,
  loadProjects,
  markBackupVerified,
  prepareDatabase,
  readSnapshot,
  saveBackupStatus,
  saveProject,
} from './repository';

beforeEach(async () => {
  await db.delete();
  await db.open();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete();
});

async function familyWithPhoto() {
  const project = await createProject('Семья', 'Анна');
  const original = new Blob(['abc'], { type: 'image/jpeg' });
  project.media.push({
    id: 'photo',
    name: 'Фото.jpg',
    mime: 'image/jpeg',
    size: original.size,
    caption: '',
    peopleIds: [project.people[0].id],
  });
  project.people[0].portraitId = 'photo';
  return saveProject(project, project.revision, [{ id: 'photo', projectId: project.id, original }]);
}

describe('сохранность минимальной версии', () => {
  it('создает архив с первым человеком одной записью и не оставляет пустой архив при ошибке', async () => {
    const project = await createProject('Моя семья', 'Анна');
    expect(project.people).toHaveLength(1);
    expect(project.revision).toBe(0);
    expect(project.trash).toEqual([]);
    await expect(createProject('Неверный архив', ' ')).rejects.toThrow();
    expect(await loadProjects()).toHaveLength(1);
  });

  it('сохраняет человека со связью целиком одной ревизией', async () => {
    const project = await createProject('Семья', 'Анна');
    const relative = newPerson('Борис');
    const changed = structuredClone(project);
    changed.people.push(relative);
    changed.relationships.push({
      id: 'relation',
      fromId: relative.id,
      toId: project.people[0].id,
      kind: 'biological',
    });
    vi.spyOn(db.projects, 'put').mockRejectedValueOnce(new Error('Нет места'));
    await expect(saveProject(changed, 0)).rejects.toThrow('Нет места');
    expect((await loadProject(project.id))?.people).toHaveLength(1);
    const saved = await saveProject(changed, 0);
    expect(saved.revision).toBe(1);
    expect(saved.people).toHaveLength(2);
    expect(saved.relationships).toHaveLength(1);
  });

  it('корзина переживает чтение и независимое восстановление без удаления оригиналов', async () => {
    let project = await familyWithPhoto();
    project = await saveProject(
      moveToTrash(project, 'person', project.people[0].id),
      project.revision,
    );
    expect(getActivePeople((await loadProject(project.id))!)).toEqual([]);
    const snapshot = await readSnapshot(project.id);
    expect(await snapshot.files[0].original.text()).toBe('abc');
    const restored = await importSnapshot(snapshot);
    expect(restored.id).not.toBe(project.id);
    expect(restored.trash).toEqual(project.trash);
    expect((await readSnapshot(restored.id)).files[0].projectId).toBe(restored.id);
    expect((await loadProject(project.id))?.revision).toBe(project.revision);
  });

  it('окончательная очистка файла и портретных ссылок откатывается целиком', async () => {
    let project = await familyWithPhoto();
    project = await saveProject(moveToTrash(project, 'media', 'photo'), project.revision);
    const cleared = purgeMedia(project, 'photo');
    vi.spyOn(db.projects, 'put').mockRejectedValueOnce(new Error('Отказ записи'));
    await expect(
      saveProject(cleared, project.revision, [], {
        cleanup: { kind: 'purge-media', mediaId: 'photo' },
      }),
    ).rejects.toThrow('Отказ записи');
    expect((await readSnapshot(project.id)).files).toHaveLength(1);
    expect((await loadProject(project.id))?.people[0].portraitId).toBe('photo');
    const saved = await saveProject(cleared, project.revision, [], {
      cleanup: { kind: 'purge-media', mediaId: 'photo' },
    });
    expect(saved.people[0].portraitId).toBeUndefined();
    expect(saved.trash).toEqual([]);
    expect((await readSnapshot(project.id)).files).toEqual([]);
  });

  it('отдельная отметка копии не меняет семейную ревизию и связывает проверку по сумме', async () => {
    const project = await createProject('Семья', 'Анна');
    const status = {
      projectId: project.id,
      revision: project.revision,
      createdAt: new Date().toISOString(),
      sha256: 'a'.repeat(64),
      confirmed: true,
    };
    await saveBackupStatus(status);
    expect(await loadBackupStatus(project.id)).toEqual(status);
    await markBackupVerified('b'.repeat(64));
    expect((await loadBackupStatus(project.id))?.verifiedAt).toBeUndefined();
    await markBackupVerified(status.sha256);
    expect((await loadBackupStatus(project.id))?.verifiedAt).toBeDefined();
    expect((await loadProject(project.id))?.revision).toBe(0);
    expect((await readSnapshot(project.id)).project).not.toHaveProperty('backupStatus');
  });

  it('не принимает большое новое описание, но позволяет уменьшить сохраненный текст корзины без восстановления группы', async () => {
    let project = await createProject('Семья', 'Анна');
    project.people.push(newPerson('Борис'), newPerson('Вера'));
    project = addRelationship(project, {
      id: 'a-b',
      fromId: project.people[0].id,
      toId: project.people[1].id,
      kind: 'biological',
    });
    project = addRelationship(project, {
      id: 'c-a',
      fromId: project.people[2].id,
      toId: project.people[0].id,
      kind: 'biological',
    });
    project = moveToTrash(project, 'person', project.people[0].id);
    project = addRelationship(project, {
      id: 'b-c',
      fromId: project.people[1].id,
      toId: project.people[2].id,
      kind: 'biological',
    });
    project.people[0].biography = 'x'.repeat(25 * 1024 * 1024 + 100);
    await expect(saveProject(project, 0)).rejects.toThrow(/25 МиБ/);
    // Имитируем сохраненную старую базу, которая раньше не проверяла объем описания.
    await db.projects.put(project);
    expect(() => restoreTrashGroup(project, project.trash[0].id)).toThrow(/цикл/);
    const changed = structuredClone(project);
    changed.people[0].biography = 'Сокращенный рассказ';
    const saved = await saveProject(changed, 0);
    expect(saved.trash).toEqual(project.trash);
    expect(getActivePeople(saved)).toHaveLength(2);
    expect(capacity.calculateCapacity(saved, []).ok).toBe(true);
  });

  it('пограничная подготовка очистки требует подтвержденной копии именно текущей ревизии', async () => {
    let project = await familyWithPhoto();
    const originalCalculate = capacity.calculateCapacity;
    vi.spyOn(capacity, 'calculateCapacity').mockImplementation((candidate, files, version) => {
      const measured = originalCalculate(candidate, files, version);
      if (!candidate.media.length) return measured;
      const over = 'trash' in candidate && candidate.trash.some((group) => group.kind === 'media');
      return {
        ...measured,
        storedBytes: capacity.CAPACITY_LIMITS.storedBytes + (over ? 100 : 0),
        ok: !over,
        violations: over ? ['storedBytes'] : [],
      };
    });
    const changed = moveToTrash(project, 'media', 'photo');
    const options = { cleanup: { kind: 'trash-media' as const, mediaId: 'photo' } };
    await expect(saveProject(changed, project.revision, [], options)).rejects.toThrow(
      /подтвердите/,
    );
    await saveBackupStatus({
      projectId: project.id,
      revision: 0,
      createdAt: new Date().toISOString(),
      sha256: 'a'.repeat(64),
      confirmed: true,
    });
    await expect(saveProject(changed, project.revision, [], options)).rejects.toThrow(
      /текущей ревизии/,
    );
    await saveBackupStatus({
      projectId: project.id,
      revision: project.revision,
      createdAt: new Date().toISOString(),
      sha256: 'b'.repeat(64),
      confirmed: true,
    });
    project = await saveProject(changed, project.revision, [], options);
    expect(project.trash).toHaveLength(1);
    const bad = structuredClone(project);
    bad.people.push(newPerson('Новая запись'));
    await expect(saveProject(bad, project.revision)).rejects.toThrow();
    project = await saveProject(purgeMedia(project, 'photo'), project.revision, [], {
      cleanup: { kind: 'purge-media', mediaId: 'photo' },
    });
    expect(capacity.calculateCapacity(project, []).ok).toBe(true);
  });

  it('переносит существующую базу v1 только после разрешенного повышения версии', async () => {
    await db.delete();
    const old = new Dexie('Rodoslovnaya');
    old.version(1).stores({ projects: 'id,updatedAt', files: '[projectId+id],projectId' });
    const project = newProject('Старый архив');
    project.people.push(newPerson('Анна'));
    const legacy = { ...project } as Partial<FamilyProject>;
    delete legacy.trash;
    await old.open();
    await old.table('projects').put(legacy);
    old.close();
    expect(await prepareDatabase(false)).toBe(false);
    expect(db.isOpen()).toBe(false);
    expect(await prepareDatabase(true)).toBe(true);
    expect(db.backendDB().version).toBe(20);
    expect(await loadProject(project.id)).toEqual(project);
    expect(await db.backupStatus.count()).toBe(0);
  });
});
