import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newPerson, type FamilyProject, type StoredFile } from '../domain/types';
import {
  createProject,
  db,
  importSnapshot,
  loadProject,
  loadProjects,
  readSnapshot,
  saveProject,
} from './repository';

async function withPhoto(): Promise<{ project: FamilyProject; file: StoredFile }> {
  const project = await createProject('Семья');
  const person = newPerson('Анна');
  project.people.push(person);
  project.media.push({
    id: 'photo',
    name: 'Фото.jpg',
    mime: 'image/jpeg',
    size: 3,
    caption: 'Дома',
    peopleIds: [person.id],
  });
  person.portraitId = 'photo';
  const file: StoredFile = {
    id: 'photo',
    projectId: project.id,
    original: new Blob(['abc'], { type: 'image/jpeg' }),
  };
  return { project: await saveProject(project, project.revision, [file]), file };
}

beforeEach(async () => {
  await db.delete();
  await db.open();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete();
});

describe('локальное хранилище', () => {
  it('создает, перечисляет и повторно загружает независимые проекты', async () => {
    const first = await createProject('Первая семья');
    const second = await createProject('Вторая семья');
    expect(first.revision).toBe(0);
    expect(await loadProject(first.id)).toEqual(first);
    expect((await loadProjects()).map((project) => project.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(await loadProject('missing')).toBeUndefined();
  });

  it('повышает ревизию только после успешной записи и обнаруживает устаревшее изменение', async () => {
    const project = await createProject('Семья');
    const saved = await saveProject({ ...project, title: 'Новая запись' }, 0);
    expect(saved.revision).toBe(1);
    expect(project.revision).toBe(0);
    await expect(saveProject({ ...project, title: 'Устаревшая запись' }, 0)).rejects.toThrow();
    expect(await loadProject(project.id)).toEqual(saved);
  });

  it('допускает только одну из двух конкурирующих записей одной ревизии', async () => {
    const project = await createProject('Семья');
    const results = await Promise.allSettled([
      saveProject({ ...project, title: 'Первое окно' }, 0),
      saveProject({ ...project, title: 'Второе окно' }, 0),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await loadProject(project.id))?.revision).toBe(1);
  });

  it('сохраняет оригинал и связанные сведения в одном снимке', async () => {
    const { project, file } = await withPhoto();
    const other = await createProject('Другая семья');
    await db.files.put({ ...file, projectId: other.id });
    const snapshot = await readSnapshot(project.id);
    expect(snapshot.project).toEqual(project);
    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.files[0].original.size).toBe(3);
    expect(await snapshot.files[0].original.text()).toBe('abc');
    expect(snapshot.files[0].projectId).toBe(project.id);
  });

  it('не записывает метаданные при отсутствующем файле и ошибке размера', async () => {
    const project = await createProject('Семья');
    project.media.push({
      id: 'doc',
      name: 'Справка.pdf',
      mime: 'application/pdf',
      size: 10,
      caption: '',
      peopleIds: [],
    });
    await expect(saveProject(project, 0)).rejects.toThrow();
    await expect(
      saveProject(project, 0, [
        {
          id: 'doc',
          projectId: project.id,
          original: new Blob(['abc'], { type: 'application/pdf' }),
        },
      ]),
    ).rejects.toThrow();
    expect((await loadProject(project.id))?.media).toEqual([]);
    expect(await db.files.count()).toBe(0);
  });

  it('отклоняет оригинал другого проекта и несовпадающий формат', async () => {
    const project = await createProject('Семья');
    project.media.push({
      id: 'doc',
      name: 'Справка.pdf',
      mime: 'application/pdf',
      size: 3,
      caption: '',
      peopleIds: [],
    });
    await expect(
      saveProject(project, 0, [
        { id: 'doc', projectId: 'other', original: new Blob(['abc'], { type: 'application/pdf' }) },
      ]),
    ).rejects.toThrow();
    await expect(
      saveProject(project, 0, [
        { id: 'doc', projectId: project.id, original: new Blob(['abc'], { type: 'image/png' }) },
      ]),
    ).rejects.toThrow();
    expect(await db.files.count()).toBe(0);
    expect((await loadProject(project.id))?.revision).toBe(0);
  });

  it('сохраняет оригинал без сообщенного браузером MIME, если формат указан в метаданных', async () => {
    const project = await createProject('Семья');
    project.media.push({
      id: 'doc',
      name: 'Справка.pdf',
      mime: 'application/pdf',
      size: 3,
      caption: '',
      peopleIds: [],
    });
    const saved = await saveProject(project, 0, [
      { id: 'doc', projectId: project.id, original: new Blob(['abc']) },
    ]);
    const snapshot = await readSnapshot(saved.id);
    const restored = await importSnapshot(snapshot);
    expect((await readSnapshot(restored.id)).files[0].original.type).toBe('');
    expect(restored.media[0].mime).toBe('application/pdf');
  });

  it('откатывает добавление файла, если последующая запись проекта не удалась', async () => {
    const project = await createProject('Семья');
    project.media.push({
      id: 'doc',
      name: 'Справка.pdf',
      mime: 'application/pdf',
      size: 3,
      caption: '',
      peopleIds: [],
    });
    vi.spyOn(db.projects, 'put').mockRejectedValueOnce(new Error('Недостаточно места'));
    await expect(
      saveProject(project, 0, [
        {
          id: 'doc',
          projectId: project.id,
          original: new Blob(['abc'], { type: 'application/pdf' }),
        },
      ]),
    ).rejects.toThrow('Недостаточно места');
    expect(await db.files.count()).toBe(0);
    expect((await loadProject(project.id))?.revision).toBe(0);
  });

  it('удаляет файл вместе с удаленными метаданными, не затрагивая другие проекты', async () => {
    const { project, file } = await withPhoto();
    const other = await createProject('Другая семья');
    await db.files.put({ ...file, projectId: other.id });
    project.media = [];
    delete project.people[0].portraitId;
    await saveProject(project, project.revision);
    expect(await db.files.get([project.id, file.id])).toBeUndefined();
    expect(await db.files.get([other.id, file.id])).toBeDefined();
  });

  it('восстанавливает отдельный проект с оригиналами и происхождением', async () => {
    const { project } = await withPhoto();
    const snapshot = await readSnapshot(project.id);
    const restored = await importSnapshot(snapshot);
    expect(restored.id).not.toBe(project.id);
    expect(restored.revision).toBe(0);
    expect(restored.people).toEqual(project.people);
    expect(restored.restoredFrom?.projectId).toBe(project.id);
    const restoredSnapshot = await readSnapshot(restored.id);
    expect(restoredSnapshot.files[0].projectId).toBe(restored.id);
    expect(await restoredSnapshot.files[0].original.text()).toBe('abc');
    expect(await loadProject(project.id)).toEqual(project);
    expect(await loadProjects()).toHaveLength(2);
  });

  it('не оставляет новый проект после ошибки импорта и не меняет исходный', async () => {
    const { project } = await withPhoto();
    const snapshot = await readSnapshot(project.id);
    snapshot.files[0].original = new Blob(['wrong'], { type: 'image/jpeg' });
    await expect(importSnapshot(snapshot)).rejects.toThrow();
    expect(await loadProjects()).toHaveLength(1);
    expect(await loadProject(project.id)).toEqual(project);
  });

  it('откатывает создание импортированного проекта при ошибке записи файлов', async () => {
    const { project } = await withPhoto();
    const snapshot = await readSnapshot(project.id);
    vi.spyOn(db.files, 'bulkAdd').mockRejectedValueOnce(new Error('Не удалось записать файл'));
    await expect(importSnapshot(snapshot)).rejects.toThrow('Не удалось записать файл');
    expect(await loadProjects()).toHaveLength(1);
    expect(await loadProject(project.id)).toEqual(project);
    expect(await db.files.count()).toBe(1);
  });

  it('не выдает поврежденный снимок как пригодную резервную копию', async () => {
    const { project } = await withPhoto();
    await db.files.delete([project.id, 'photo']);
    await expect(readSnapshot(project.id)).rejects.toThrow();
    await expect(readSnapshot('missing')).rejects.toThrow();
  });
});
