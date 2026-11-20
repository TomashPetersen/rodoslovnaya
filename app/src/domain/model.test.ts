import { describe, expect, it } from 'vitest';
import {
  addRelationship,
  getActivePeople,
  getActiveRelationships,
  migrateLegacyProject,
  moveToTrash,
  newProject,
  purgeMedia,
  restoreTrashGroup,
  setPortrait,
  updateMaterialPeople,
  updateRelationship,
  validateLegacyProject,
  validateProject,
} from './model';
import { newPerson, type FamilyProject, type Relationship } from './types';

function family(): FamilyProject {
  return {
    ...newProject('Семья'),
    people: [newPerson('Анна'), newPerson('Борис'), newPerson('Вера'), newPerson('Глеб')],
  };
}

function relation(
  project: FamilyProject,
  from: number,
  to: number,
  kind: Relationship['kind'] = 'biological',
): Relationship {
  return {
    id: crypto.randomUUID(),
    fromId: project.people[from].id,
    toId: project.people[to].id,
    kind,
  };
}

describe('проверка родословной', () => {
  it('создает независимый пустой проект с начальной ревизией', () => {
    const project = newProject('  Семья Петровых  ');
    expect(project.title).toBe('Семья Петровых');
    expect(project.revision).toBe(0);
    expect(project.people).toEqual([]);
    expect(project.id).not.toBe(newProject('Другая семья').id);
    expect(() => validateProject(project)).not.toThrow();
    expect(() => newProject('  ')).toThrow();
  });

  it.each(['', '2000', '2000-02', '2000-02-29', '~1930', '~1930-02', '~1930-02-28'])(
    'принимает дату %s без дополнения точности',
    (date) => {
      const project = family();
      project.people[0].birthDate = date;
      expect(() => validateProject(project)).not.toThrow();
      expect(project.people[0].birthDate).toBe(date);
    },
  );

  it.each([
    '1900-02-29',
    '2024-02-30',
    '2024-13',
    '2024-00',
    '0000',
    '2024-01-00',
    '2024-04-31',
    '1 января 2000',
    '2024-1-1',
    '~~2000',
    '~',
  ])('отклоняет невозможную или неподдерживаемую дату %s', (date) => {
    const project = family();
    project.people[0].deathDate = date;
    expect(() => validateProject(project)).toThrow();
  });

  it.each([
    (project: FamilyProject) => ({ ...project, unexpected: true }),
    (project: FamilyProject) => ({ ...project, revision: NaN }),
    (project: FamilyProject) => ({ ...project, revision: 1.5 }),
    (project: FamilyProject) => ({ ...project, people: [{ ...project.people[0], name: ' ' }] }),
    (project: FamilyProject) => ({
      ...project,
      people: [{ ...project.people[0], lifeStatus: 'maybe' }],
    }),
    (project: FamilyProject) => ({ ...project, people: [{ ...project.people[0], source: [] }] }),
    (project: FamilyProject) => ({ ...project, createdAt: '2024-02-30T12:00:00.000Z' }),
    (project: FamilyProject) => ({ ...project, updatedAt: '1900-01-01T00:00:00.000Z' }),
  ])('отклоняет неверные типы и неизвестные поля', (change) => {
    expect(() => validateProject(change(family()))).toThrow();
  });

  it('отклоняет повторные идентификаторы и отсутствующие ссылки', () => {
    const project = family();
    project.people.push({ ...project.people[0] });
    expect(() => validateProject(project)).toThrow();
    project.people.pop();
    project.stories.push({
      id: 'story',
      title: 'Воспоминание',
      text: 'Текст',
      peopleIds: ['missing'],
    });
    expect(() => validateProject(project)).toThrow();
  });

  it('не допускает PDF в качестве портрета и повтор людей у материала', () => {
    const project = family();
    project.media.push({
      id: 'doc',
      name: 'Справка.pdf',
      mime: 'application/pdf',
      size: 3,
      caption: '',
      peopleIds: [project.people[0].id],
    });
    project.people[0].portraitId = 'doc';
    expect(() => validateProject(project)).toThrow();
    delete project.people[0].portraitId;
    project.media[0].peopleIds.push(project.people[0].id);
    expect(() => validateProject(project)).toThrow();
  });
});

describe('корзина и совместимость', () => {
  it('сохраняет общие материалы и восстанавливает связанные группы в допустимом порядке', () => {
    let project = family();
    project = addRelationship(project, relation(project, 0, 1));
    project.media.push({
      id: 'photo',
      name: 'Фото.jpg',
      mime: 'image/jpeg',
      size: 3,
      caption: '',
      peopleIds: [project.people[0].id, project.people[1].id],
    });
    const original = structuredClone(project);
    project = moveToTrash(project, 'person', project.people[0].id);
    const firstGroup = project.trash[0].id;
    project = moveToTrash(project, 'person', project.people[1].id);
    expect(project.trash[0].relationshipIds).toHaveLength(1);
    expect(project.trash[1].relationshipIds).toEqual([]);
    expect(project.media).toEqual(original.media);
    expect(getActiveRelationships(project)).toEqual([]);
    expect(() => restoreTrashGroup(project, firstGroup)).toThrow(/Борис/);
    expect(project.trash).toHaveLength(2);
    project = restoreTrashGroup(project, project.trash[1].id);
    project = restoreTrashGroup(project, firstGroup);
    expect(project).toEqual(original);
    expect(getActivePeople(project)).toHaveLength(4);
  });

  it('не восстанавливает дубликат связи и не меняет исходную группу', () => {
    let project = family();
    project = addRelationship(project, relation(project, 0, 1));
    project = moveToTrash(project, 'relationship', project.relationships[0].id);
    project = addRelationship(project, relation(project, 0, 1));
    expect(getActiveRelationships(project)).toHaveLength(1);
    expect(() => restoreTrashGroup(project, project.trash[0].id)).toThrow(/уже существует/);
    expect(project.trash).toHaveLength(1);
  });

  it('отклоняет цикл при восстановлении человека целиком', () => {
    let project = family();
    project = addRelationship(project, relation(project, 0, 1));
    project = addRelationship(project, relation(project, 2, 0));
    project = moveToTrash(project, 'person', project.people[0].id);
    project = addRelationship(project, relation(project, 1, 2));
    expect(() => restoreTrashGroup(project, project.trash[0].id)).toThrow(/цикл/);
    expect(getActivePeople(project)).toHaveLength(3);
    expect(project.relationships).toHaveLength(3);
  });

  it('проверяет изменение существующей связи и запрещает правку связи корзины', () => {
    let project = family();
    project = addRelationship(project, relation(project, 0, 1));
    const rel = project.relationships[0];
    expect(() => updateRelationship(project, { ...rel, toId: rel.fromId })).toThrow();
    project = updateRelationship(project, { ...rel, kind: 'adoptive' });
    expect(project.relationships[0].kind).toBe('adoptive');
    project = moveToTrash(project, 'relationship', rel.id);
    expect(() => updateRelationship(project, rel)).toThrow(/восстановите/);
  });

  it('сохраняет удаленный портрет, не заменяет позднейший и очищает ссылки при окончательном удалении', () => {
    let project = family();
    for (const id of ['old', 'new'])
      project.media.push({
        id,
        name: `${id}.jpg`,
        mime: 'image/jpeg',
        size: 3,
        caption: '',
        peopleIds: [project.people[0].id, project.people[1].id],
      });
    project = setPortrait(project, project.people[0].id, 'old');
    project = setPortrait(project, project.people[1].id, 'old');
    project = moveToTrash(project, 'media', 'old');
    expect(project.people[0].portraitId).toBe('old');
    expect(() => setPortrait(project, project.people[0].id, 'old')).toThrow();
    project = setPortrait(project, project.people[0].id, 'new');
    project = restoreTrashGroup(project, project.trash[0].id);
    expect(project.people[0].portraitId).toBe('new');
    project = moveToTrash(project, 'person', project.people[1].id);
    project = moveToTrash(project, 'media', 'old');
    project = purgeMedia(project, 'old');
    expect(project.people[0].portraitId).toBe('new');
    expect(project.people[1].portraitId).toBeUndefined();
    expect(project.media.map((item) => item.id)).toEqual(['new']);
    expect(() => purgeMedia(project, 'new')).toThrow(/корзины/);
  });

  it('очищает портретные ссылки исключенного участника, включая человека корзины', () => {
    let project = family();
    project.media.push({
      id: 'photo',
      name: 'Фото.jpg',
      mime: 'image/jpeg',
      size: 3,
      caption: '',
      peopleIds: [project.people[0].id, project.people[1].id],
    });
    project = setPortrait(project, project.people[0].id, 'photo');
    project = moveToTrash(project, 'person', project.people[0].id);
    project = updateMaterialPeople(project, 'media', 'photo', [project.people[1].id]);
    expect(project.people[0].portraitId).toBeUndefined();
    expect(() => setPortrait(project, project.people[2].id, 'photo')).toThrow();
  });

  it('отклоняет повторное членство и чужую связь в группе человека', () => {
    let project = family();
    project = addRelationship(project, relation(project, 0, 1));
    project = addRelationship(project, relation(project, 2, 3));
    project = moveToTrash(project, 'person', project.people[0].id);
    const wrong = structuredClone(project);
    wrong.trash[0].relationshipIds.push(project.relationships[1].id);
    expect(() => validateProject(wrong)).toThrow(/не относится/);
    project.trash.push({ ...project.trash[0], id: 'duplicate-group' });
    expect(() => validateProject(project)).toThrow(/нескольких группах/);
  });

  it('сначала проверяет прежний формат и переносит его без потерь', () => {
    const project = family();
    const legacy = { ...project } as Partial<FamilyProject>;
    delete legacy.trash;
    expect(() => validateLegacyProject(legacy)).not.toThrow();
    expect(() => validateProject(legacy)).toThrow(/обязательное поле/);
    expect(migrateLegacyProject(legacy)).toEqual(project);
    expect(() => validateLegacyProject(project)).toThrow(/неизвестное поле/);
    expect(() => migrateLegacyProject({ ...legacy, unexpected: true })).toThrow();
  });
});

describe('изменение семейных связей', () => {
  it('добавляет связь без изменения исходного проекта и его ревизии', () => {
    const project = family();
    const changed = addRelationship(project, relation(project, 0, 1));
    expect(project.relationships).toHaveLength(0);
    expect(changed.relationships).toHaveLength(1);
    expect(changed.revision).toBe(project.revision);
  });

  it('отклоняет самоссылку, отсутствующего человека и дубликат', () => {
    const project = family();
    expect(() => addRelationship(project, relation(project, 0, 0))).toThrow();
    expect(() =>
      addRelationship(project, { ...relation(project, 0, 1), toId: 'missing' }),
    ).toThrow();
    const changed = addRelationship(project, relation(project, 0, 1));
    expect(() => addRelationship(changed, relation(project, 0, 1))).toThrow();
  });

  it('считает обратное партнерство дубликатом независимо от статуса', () => {
    const project = family();
    const changed = addRelationship(project, {
      ...relation(project, 0, 1, 'partner'),
      status: 'together',
    });
    expect(() =>
      addRelationship(changed, { ...relation(project, 1, 0, 'partner'), status: 'separated' }),
    ).toThrow();
  });

  it('отклоняет цикл с участием биологического и приемного родительства', () => {
    let project = family();
    project = addRelationship(project, relation(project, 0, 1));
    project = addRelationship(project, relation(project, 1, 2, 'adoptive'));
    expect(() => addRelationship(project, relation(project, 2, 0))).toThrow();
  });

  it('принимает общего предка в разных ветвях и партнерство родственников', () => {
    let project = family();
    project = addRelationship(project, relation(project, 0, 1));
    project = addRelationship(project, relation(project, 0, 2));
    project = addRelationship(project, relation(project, 1, 3));
    project = addRelationship(project, relation(project, 2, 3));
    project = addRelationship(project, relation(project, 1, 2, 'partner'));
    expect(() => validateProject(project)).not.toThrow();
  });

  it('сохраняет биологических и приемных родителей одновременно', () => {
    let project = family();
    project = addRelationship(project, relation(project, 0, 3));
    project = addRelationship(project, relation(project, 1, 3, 'adoptive'));
    expect(project.relationships).toHaveLength(2);
  });
});
