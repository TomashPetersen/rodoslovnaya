import type { FamilyProject, LegacyFamilyProject, Relationship, TrashKind } from './types';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

type RecordValue = Record<string, unknown>;

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ValidationError(message);
}

function record(value: unknown, label: string): asserts value is RecordValue {
  requireValue(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    `${label}: ожидается объект.`,
  );
  const prototype: unknown = Object.getPrototypeOf(value);
  requireValue(
    prototype === Object.prototype || prototype === null,
    `${label}: недопустимый тип объекта.`,
  );
}

function fields(value: RecordValue, required: string[], optional: string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  requireValue(
    Reflect.ownKeys(value).every((key) => typeof key === 'string' && allowed.has(key)),
    `${label}: неизвестное поле.`,
  );
  requireValue(
    required.every((key) => Object.hasOwn(value, key)),
    `${label}: отсутствует обязательное поле.`,
  );
}

function string(value: unknown, label: string, nonempty = false): asserts value is string {
  requireValue(
    typeof value === 'string' && (!nonempty || value.trim().length > 0),
    `${label}: ожидается ${nonempty ? 'непустая строка' : 'строка'}.`,
  );
}

function id(value: unknown, label: string): asserts value is string {
  string(value, label, true);
  requireValue(value.trim() === value, `${label}: пробелы вокруг идентификатора недопустимы.`);
}

function array(value: unknown, label: string): asserts value is unknown[] {
  requireValue(Array.isArray(value), `${label}: ожидается список.`);
}

function integer(value: unknown, label: string): asserts value is number {
  requireValue(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    `${label}: ожидается целое неотрицательное число.`,
  );
}

function timestamp(value: unknown, label: string): asserts value is string {
  string(value, label);
  requireValue(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value),
    `${label}: ожидается точная дата и время UTC.`,
  );
  const parsed = new Date(value);
  requireValue(
    !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value,
    `${label}: неверная дата и время.`,
  );
}

function genealogyDate(value: unknown, label: string): void {
  string(value, label);
  if (value === '') return;
  const match = /^~?(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
  requireValue(
    match,
    `${label}: используйте год, год-месяц или год-месяц-день; приблизительная дата начинается с ~.`,
  );
  const year = Number(match[1]);
  const month = match[2] === undefined ? undefined : Number(match[2]);
  const day = match[3] === undefined ? undefined : Number(match[3]);
  requireValue(year >= 1, `${label}: год должен быть положительным.`);
  if (month === undefined) return;
  requireValue(month >= 1 && month <= 12, `${label}: неверный месяц.`);
  if (day === undefined) return;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  requireValue(day >= 1 && day <= days[month - 1], `${label}: такого дня в месяце нет.`);
}

function uniqueId(value: RecordValue, seen: Set<string>, label: string): void {
  id(value.id, `${label}: идентификатор`);
  requireValue(!seen.has(value.id), `${label}: повторный идентификатор.`);
  seen.add(value.id);
}

function peopleReferences(value: unknown, peopleIds: Set<string>, label: string): void {
  array(value, label);
  const seen = new Set<string>();
  for (const personId of value) {
    id(personId, label);
    requireValue(peopleIds.has(personId), `${label}: человек не найден.`);
    requireValue(!seen.has(personId), `${label}: человек указан несколько раз.`);
    seen.add(personId);
  }
}

function validateProjectShape(project: unknown, legacy: boolean): void {
  record(project, 'Проект');
  fields(
    project,
    [
      'id',
      'title',
      'revision',
      'createdAt',
      'updatedAt',
      'people',
      'relationships',
      'stories',
      'media',
      ...(legacy ? [] : ['trash']),
    ],
    ['restoredFrom'],
    'Проект',
  );
  id(project.id, 'Идентификатор проекта');
  string(project.title, 'Название проекта', true);
  integer(project.revision, 'Номер изменения');
  timestamp(project.createdAt, 'Дата создания');
  timestamp(project.updatedAt, 'Дата изменения');
  requireValue(project.updatedAt >= project.createdAt, 'Дата изменения раньше создания проекта.');
  if (project.restoredFrom !== undefined) {
    record(project.restoredFrom, 'Происхождение копии');
    fields(project.restoredFrom, ['projectId', 'createdAt'], [], 'Происхождение копии');
    id(project.restoredFrom.projectId, 'Исходный проект');
    timestamp(project.restoredFrom.createdAt, 'Дата исходной копии');
  }

  array(project.people, 'Люди');
  const peopleIds = new Set<string>();
  for (const person of project.people) {
    record(person, 'Человек');
    fields(
      person,
      ['id', 'name', 'birthDate', 'deathDate', 'birthPlace', 'lifeStatus', 'biography', 'source'],
      ['portraitId'],
      'Человек',
    );
    uniqueId(person, peopleIds, 'Человек');
    string(person.name, 'Имя', true);
    genealogyDate(person.birthDate, 'Дата рождения');
    genealogyDate(person.deathDate, 'Дата смерти');
    string(person.birthPlace, 'Место рождения');
    string(person.biography, 'Биография');
    string(person.source, 'Источник');
    requireValue(
      person.lifeStatus === 'unknown' ||
        person.lifeStatus === 'alive' ||
        person.lifeStatus === 'deceased',
      'Неизвестный статус жизни.',
    );
    if (person.portraitId !== undefined) id(person.portraitId, 'Портрет');
  }

  array(project.relationships, 'Связи');
  const relationshipIds = new Set<string>();
  for (const relationship of project.relationships) {
    record(relationship, 'Связь');
    fields(relationship, ['id', 'fromId', 'toId', 'kind'], ['status'], 'Связь');
    uniqueId(relationship, relationshipIds, 'Связь');
    id(relationship.fromId, 'Первый человек связи');
    id(relationship.toId, 'Второй человек связи');
    requireValue(
      peopleIds.has(relationship.fromId) && peopleIds.has(relationship.toId),
      'Участник связи не найден.',
    );
    requireValue(
      relationship.fromId !== relationship.toId,
      'Нельзя связать человека с самим собой.',
    );
    requireValue(
      relationship.kind === 'biological' ||
        relationship.kind === 'adoptive' ||
        relationship.kind === 'partner',
      'Неизвестный тип связи.',
    );
    if (relationship.status !== undefined) {
      requireValue(
        relationship.kind === 'partner' &&
          (relationship.status === 'together' || relationship.status === 'separated'),
        'Неверный статус партнерства.',
      );
    }
  }

  array(project.stories, 'Рассказы');
  const storyIds = new Set<string>();
  for (const story of project.stories) {
    record(story, 'Рассказ');
    fields(story, ['id', 'title', 'text', 'peopleIds'], [], 'Рассказ');
    uniqueId(story, storyIds, 'Рассказ');
    string(story.title, 'Название рассказа', true);
    string(story.text, 'Текст рассказа');
    peopleReferences(story.peopleIds, peopleIds, 'Люди рассказа');
  }

  array(project.media, 'Материалы');
  const mediaIds = new Set<string>();
  const mediaTypes = new Map<string, string>();
  for (const material of project.media) {
    record(material, 'Материал');
    fields(material, ['id', 'name', 'mime', 'size', 'caption', 'peopleIds'], [], 'Материал');
    uniqueId(material, mediaIds, 'Материал');
    string(material.name, 'Название файла', true);
    requireValue(
      material.mime === 'image/jpeg' ||
        material.mime === 'image/png' ||
        material.mime === 'image/webp' ||
        material.mime === 'application/pdf',
      'Формат материала не поддерживается.',
    );
    integer(material.size, 'Размер материала');
    string(material.caption, 'Подпись материала');
    peopleReferences(material.peopleIds, peopleIds, 'Люди материала');
    mediaTypes.set(material.id as string, material.mime);
  }
  for (const person of project.people) {
    const portraitId = (person as RecordValue).portraitId;
    if (typeof portraitId === 'string')
      requireValue(
        mediaTypes.get(portraitId)?.startsWith('image/'),
        'Портрет должен ссылаться на существующее изображение.',
      );
  }

  const groups = legacy ? [] : project.trash;
  array(groups, 'Корзина');
  const groupIds = new Set<string>();
  const deleted: Record<TrashKind, Set<string>> = {
    person: new Set(),
    relationship: new Set(),
    media: new Set(),
    story: new Set(),
  };
  const entityIds = {
    person: peopleIds,
    relationship: relationshipIds,
    media: mediaIds,
    story: storyIds,
  };
  for (const group of groups) {
    record(group, 'Группа корзины');
    fields(group, ['id', 'deletedAt', 'kind', 'entityId', 'relationshipIds'], [], 'Группа корзины');
    uniqueId(group, groupIds, 'Группа корзины');
    timestamp(group.deletedAt, 'Дата удаления');
    requireValue(
      ['person', 'relationship', 'media', 'story'].includes(group.kind as string),
      'Неизвестный вид записи корзины.',
    );
    const kind = group.kind as TrashKind;
    id(group.entityId, 'Запись корзины');
    requireValue(entityIds[kind].has(group.entityId), 'Запись корзины не найдена.');
    requireValue(
      !deleted[kind].has(group.entityId),
      'Запись находится в нескольких группах корзины.',
    );
    deleted[kind].add(group.entityId);
    array(group.relationshipIds, 'Связи группы корзины');
    requireValue(
      kind === 'person' || group.relationshipIds.length === 0,
      'Связи допустимы только в группе человека.',
    );
    for (const relationshipId of group.relationshipIds) {
      id(relationshipId, 'Связь корзины');
      const relation = (project.relationships as unknown as Relationship[]).find(
        (item) => item.id === relationshipId,
      );
      requireValue(
        relation && (relation.fromId === group.entityId || relation.toId === group.entityId),
        'Связь корзины не относится к удаленному человеку.',
      );
      requireValue(
        !deleted.relationship.has(relationshipId),
        'Связь находится в нескольких группах корзины.',
      );
      deleted.relationship.add(relationshipId);
    }
  }
  const activeIds = new Set([...peopleIds].filter((personId) => !deleted.person.has(personId)));
  const relationshipKeys = new Set<string>();
  const children = new Map<string, string[]>();
  const indegrees = new Map([...activeIds].map((personId) => [personId, 0]));
  for (const relation of project.relationships as unknown as Relationship[]) {
    if (deleted.relationship.has(relation.id)) continue;
    requireValue(
      activeIds.has(relation.fromId) && activeIds.has(relation.toId),
      'Связь требует человека из корзины. Сначала восстановите его группу.',
    );
    const endpoints =
      relation.kind === 'partner'
        ? [relation.fromId, relation.toId].sort()
        : [relation.fromId, relation.toId];
    const key = JSON.stringify([relation.kind, ...endpoints]);
    requireValue(!relationshipKeys.has(key), 'Такая семейная связь уже существует.');
    relationshipKeys.add(key);
    if (relation.kind !== 'partner') {
      const descendants = children.get(relation.fromId) ?? [];
      descendants.push(relation.toId);
      children.set(relation.fromId, descendants);
      indegrees.set(relation.toId, indegrees.get(relation.toId)! + 1);
    }
  }
  const queue = [...activeIds].filter((personId) => indegrees.get(personId) === 0);
  for (let index = 0; index < queue.length; index++) {
    for (const childId of children.get(queue[index]) ?? []) {
      const remaining = indegrees.get(childId)! - 1;
      indegrees.set(childId, remaining);
      if (remaining === 0) queue.push(childId);
    }
  }
  requireValue(
    queue.length === activeIds.size,
    'Связь создает цикл происхождения: человек оказывается собственным предком.',
  );
}

export function validateProject(project: unknown): asserts project is FamilyProject {
  validateProjectShape(project, false);
}

export function validateLegacyProject(project: unknown): asserts project is LegacyFamilyProject {
  validateProjectShape(project, true);
}

export function migrateLegacyProject(project: unknown): FamilyProject {
  validateLegacyProject(project);
  const migrated = { ...structuredClone(project), trash: [] };
  validateProject(migrated);
  return migrated;
}

export function newProject(title: string): FamilyProject {
  const now = new Date().toISOString();
  const project: FamilyProject = {
    id: crypto.randomUUID(),
    title: title.trim(),
    revision: 0,
    createdAt: now,
    updatedAt: now,
    people: [],
    relationships: [],
    stories: [],
    media: [],
    trash: [],
  };
  validateProject(project);
  return project;
}

type WithTrash = Partial<Pick<FamilyProject, 'trash'>>;

export function isDeleted(project: WithTrash, kind: TrashKind, entityId: string): boolean {
  return (project.trash ?? []).some(
    (group) =>
      (group.kind === kind && group.entityId === entityId) ||
      (kind === 'relationship' && group.relationshipIds.includes(entityId)),
  );
}

export const getActivePeople = (project: Pick<FamilyProject, 'people'> & WithTrash) =>
  project.people.filter((person) => !isDeleted(project, 'person', person.id));
export const getActiveRelationships = (project: Pick<FamilyProject, 'relationships'> & WithTrash) =>
  project.relationships.filter(
    (relation) =>
      !isDeleted(project, 'relationship', relation.id) &&
      !isDeleted(project, 'person', relation.fromId) &&
      !isDeleted(project, 'person', relation.toId),
  );
export const getActiveMedia = (project: Pick<FamilyProject, 'media'> & WithTrash) =>
  project.media.filter((media) => !isDeleted(project, 'media', media.id));
export const getActiveStories = (project: Pick<FamilyProject, 'stories'> & WithTrash) =>
  project.stories.filter((story) => !isDeleted(project, 'story', story.id));

export function getActiveRecords(project: FamilyProject) {
  return {
    people: getActivePeople(project),
    relationships: getActiveRelationships(project),
    media: getActiveMedia(project),
    stories: getActiveStories(project),
  };
}

function changedProject(
  project: FamilyProject,
  change: (next: FamilyProject) => void,
): FamilyProject {
  validateProject(project);
  const next = structuredClone(project);
  change(next);
  validateProject(next);
  return next;
}

export function moveToTrash(
  project: FamilyProject,
  kind: TrashKind,
  entityId: string,
): FamilyProject {
  return changedProject(project, (next) => {
    requireValue(!isDeleted(next, kind, entityId), 'Запись уже находится в корзине.');
    const collection =
      kind === 'person'
        ? next.people
        : kind === 'relationship'
          ? next.relationships
          : kind === 'media'
            ? next.media
            : next.stories;
    requireValue(
      collection.some((item) => item.id === entityId),
      'Удаляемая запись не найдена.',
    );
    next.trash.push({
      id: crypto.randomUUID(),
      deletedAt: new Date().toISOString(),
      kind,
      entityId,
      relationshipIds:
        kind === 'person'
          ? getActiveRelationships(next)
              .filter((relation) => relation.fromId === entityId || relation.toId === entityId)
              .map((relation) => relation.id)
          : [],
    });
  });
}

export function restoreTrashGroup(project: FamilyProject, groupId: string): FamilyProject {
  return changedProject(project, (next) => {
    const group = next.trash.find((item) => item.id === groupId);
    requireValue(group, 'Группа корзины не найдена.');
    const relationIds = group.kind === 'relationship' ? [group.entityId] : group.relationshipIds;
    for (const relation of next.relationships.filter((item) => relationIds.includes(item.id))) {
      for (const personId of [relation.fromId, relation.toId]) {
        if (personId === group.entityId && group.kind === 'person') continue;
        const person = next.people.find((item) => item.id === personId)!;
        requireValue(
          !isDeleted(next, 'person', personId),
          `Сначала восстановите человека «${person.name}» из корзины.`,
        );
      }
    }
    next.trash = next.trash.filter((item) => item.id !== groupId);
  });
}

export function purgeMedia(project: FamilyProject, mediaId: string): FamilyProject {
  return changedProject(project, (next) => {
    requireValue(
      isDeleted(next, 'media', mediaId),
      'Окончательно удалить можно только материал корзины.',
    );
    next.media = next.media.filter((item) => item.id !== mediaId);
    next.trash = next.trash.filter(
      (group) => !(group.kind === 'media' && group.entityId === mediaId),
    );
    for (const person of next.people) if (person.portraitId === mediaId) delete person.portraitId;
  });
}

export function updateRelationship(project: FamilyProject, relation: Relationship): FamilyProject {
  return changedProject(project, (next) => {
    requireValue(
      !isDeleted(next, 'relationship', relation.id),
      'Сначала восстановите связь из корзины.',
    );
    const index = next.relationships.findIndex((item) => item.id === relation.id);
    requireValue(index >= 0, 'Связь не найдена.');
    next.relationships[index] = structuredClone(relation);
  });
}

export function setPortrait(
  project: FamilyProject,
  personId: string,
  mediaId?: string,
): FamilyProject {
  return changedProject(project, (next) => {
    const person = next.people.find((item) => item.id === personId);
    requireValue(person && !isDeleted(next, 'person', personId), 'Активный человек не найден.');
    if (mediaId === undefined) {
      delete person.portraitId;
      return;
    }
    const material = next.media.find((item) => item.id === mediaId);
    requireValue(
      material &&
        !isDeleted(next, 'media', mediaId) &&
        material.mime.startsWith('image/') &&
        material.peopleIds.includes(personId),
      'Выберите активную фотографию, среди участников которой указан этот человек.',
    );
    person.portraitId = mediaId;
  });
}

export function updateMaterialPeople(
  project: FamilyProject,
  kind: 'media' | 'story',
  entityId: string,
  peopleIds: string[],
): FamilyProject {
  return changedProject(project, (next) => {
    requireValue(!isDeleted(next, kind, entityId), 'Сначала восстановите материал из корзины.');
    const item = (kind === 'media' ? next.media : next.stories).find(
      (item) => item.id === entityId,
    );
    requireValue(item, 'Материал не найден.');
    item.peopleIds = [...peopleIds];
    if (kind === 'media')
      for (const person of next.people) {
        if (person.portraitId === entityId && !peopleIds.includes(person.id))
          delete person.portraitId;
      }
  });
}

export function addRelationship(project: FamilyProject, relationship: Relationship): FamilyProject {
  validateProject(project);
  const changed = { ...project, relationships: [...project.relationships, { ...relationship }] };
  validateProject(changed);
  return changed;
}
