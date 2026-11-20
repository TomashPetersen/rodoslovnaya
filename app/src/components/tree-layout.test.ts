import { describe, expect, it } from 'vitest';
import type { FamilyProject, Person, Relationship } from '../domain/types';
import { buildLayoutGraph, projectBranch } from './tree-layout';

function person(id: string): Person {
  return {
    id,
    name: id,
    birthDate: '',
    deathDate: '',
    birthPlace: '',
    lifeStatus: 'unknown',
    biography: '',
    source: '',
  };
}

function family(ids: string[], relationships: Relationship[]): FamilyProject {
  return {
    id: 'family',
    title: 'Семья',
    revision: 0,
    createdAt: '',
    updatedAt: '',
    people: ids.map(person),
    relationships,
    stories: [],
    media: [],
    trash: [],
  };
}

function parent(
  fromId: string,
  toId: string,
  kind: 'biological' | 'adoptive' = 'biological',
): Relationship {
  return { id: `${fromId}-${toId}-${kind}`, fromId, toId, kind };
}

describe('Выбранная ветвь родословной', () => {
  it('открывает близкую семью, а дальние поколения показывает только по команде', () => {
    const project = family(
      ['я', 'родитель', 'дед', 'ребенок', 'внук', 'партнер', 'другая семья'],
      [
        parent('родитель', 'я'),
        parent('дед', 'родитель'),
        parent('я', 'ребенок'),
        parent('ребенок', 'внук'),
        { id: 'союз', fromId: 'я', toId: 'партнер', kind: 'partner' },
      ],
    );
    const near = projectBranch(project, 'я', 1, 1);
    expect(new Set(near.people.map((p) => p.id))).toEqual(
      new Set(['я', 'родитель', 'ребенок', 'партнер']),
    );
    const expanded = projectBranch(project, 'я', 2, 2);
    expect(expanded.people.map((p) => p.id)).toContain('дед');
    expect(expanded.people.map((p) => p.id)).toContain('внук');
    expect(expanded.people.map((p) => p.id)).not.toContain('другая семья');
  });

  it('сохраняет биологических и приемных родителей одновременно', () => {
    const project = family(
      ['ребенок', 'биологический', 'приемный'],
      [parent('биологический', 'ребенок'), parent('приемный', 'ребенок', 'adoptive')],
    );
    const branch = projectBranch(project, 'ребенок');
    expect(branch.people).toHaveLength(3);
    expect(branch.relationships.map((r) => r.kind).sort()).toEqual(['adoptive', 'biological']);
  });

  it('показывает общего предка одной записью, сохраняя обе линии происхождения', () => {
    const project = family(
      ['я', 'а', 'б', 'общий предок'],
      [
        parent('а', 'я'),
        parent('б', 'я'),
        parent('общий предок', 'а'),
        parent('общий предок', 'б'),
      ],
    );
    const branch = projectBranch(project, 'я', 2);
    expect(branch.people.filter((p) => p.id === 'общий предок')).toHaveLength(1);
    expect(branch.relationships.filter((r) => r.fromId === 'общий предок')).toHaveLength(2);
    expect(branch.repeatedAncestorIds).toContain('общий предок');
  });

  it('сохраняет повторные партнерства и не приписывает партнерам чужих детей', () => {
    const relationships: Relationship[] = [
      {
        id: 'первый союз',
        fromId: 'я',
        toId: 'первый партнер',
        kind: 'partner',
        status: 'separated',
      },
      {
        id: 'второй союз',
        fromId: 'второй партнер',
        toId: 'я',
        kind: 'partner',
        status: 'together',
      },
      parent('я', 'ребенок'),
      parent('первый партнер', 'ребенок'),
    ];
    const branch = projectBranch(
      family(['я', 'первый партнер', 'второй партнер', 'ребенок'], relationships),
      'я',
    );
    expect(branch.relationships).toHaveLength(4);
    expect(
      branch.relationships.some((r) => r.fromId === 'второй партнер' && r.toId === 'ребенок'),
    ).toBe(false);
    const layout = buildLayoutGraph(branch);
    const partnerGroup = [...layout.membersByGroup.values()].find((members) =>
      members.some((p) => p.id === 'я'),
    );
    expect(new Set(partnerGroup?.map((p) => p.id))).toEqual(
      new Set(['я', 'первый партнер', 'второй партнер']),
    );
    expect(layout.graph.children).toHaveLength(2);
  });

  it('ограничивает широкую ветвь и сохраняет доступ к выбранному человеку', () => {
    const children = Array.from({ length: 1000 }, (_, i) => `ребенок-${i}`);
    const branch = projectBranch(
      family(
        ['я', ...children],
        children.map((id) => parent('я', id)),
      ),
      'я',
    );
    expect(branch.people).toHaveLength(80);
    expect(branch.people.map((p) => p.id)).toContain('я');
    expect(branch.hiddenCount).toBe(921);
    const ids = new Set(branch.people.map((p) => p.id));
    expect(branch.relationships.every((r) => ids.has(r.fromId) && ids.has(r.toId))).toBe(true);
  });

  it('безопасно обрабатывает пустой проект и устаревший выбор карточки', () => {
    expect(projectBranch(family([], []), null).people).toEqual([]);
    expect(projectBranch(family(['первый'], []), 'удаленная карточка').selectedId).toBe('первый');
  });

  it('исключает человека и связи корзины даже при устаревшем выборе карточки', () => {
    const relationship = parent('родитель', 'ребенок');
    const project = family(['ребенок', 'родитель'], [relationship]);
    project.trash.push({
      id: 'deleted',
      deletedAt: '2026-11-17T00:00:00.000Z',
      kind: 'person',
      entityId: 'родитель',
      relationshipIds: [relationship.id],
    });
    const branch = projectBranch(project, 'родитель');
    expect(branch.selectedId).toBe('ребенок');
    expect(branch.people.map((p) => p.id)).toEqual(['ребенок']);
    expect(branch.relationships).toEqual([]);
  });

  it('показывает пустое дерево, когда последний человек находится в корзине', () => {
    const project = family(['последний'], []);
    project.trash.push({
      id: 'deleted',
      deletedAt: '2026-11-17T00:00:00.000Z',
      kind: 'person',
      entityId: 'последний',
      relationshipIds: [],
    });
    const branch = projectBranch(project, 'последний');
    expect(branch.people).toEqual([]);
    expect(branch.selectedId).toBeNull();
  });
});
