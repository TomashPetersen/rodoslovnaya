import type { FamilyProject, Person, Relationship } from '../domain/types';
import { getActivePeople, getActiveRelationships } from '../domain/model';

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 100;
const PARTNER_GAP = 108;
export const MAX_VISIBLE_PEOPLE = 80;

export interface BranchProjection {
  people: Person[];
  relationships: Relationship[];
  selectedId: string | null;
  hiddenCount: number;
  repeatedAncestorIds: Set<string>;
}

function addToMap(map: Map<string, string[]>, from: string, to: string) {
  const values = map.get(from) ?? [];
  values.push(to);
  map.set(from, values);
}

export function projectBranch(
  project: Pick<FamilyProject, 'people' | 'relationships'> & Partial<Pick<FamilyProject, 'trash'>>,
  selectedId: string | null,
  ancestorDepth = 1,
  descendantDepth = 1,
  limit = MAX_VISIBLE_PEOPLE,
): BranchProjection {
  const people = getActivePeople(project);
  const relationships = getActiveRelationships(project);
  const peopleById = new Map(people.map((person) => [person.id, person]));
  const root = selectedId && peopleById.has(selectedId) ? selectedId : people[0]?.id;
  if (!root)
    return {
      people: [],
      relationships: [],
      selectedId: null,
      hiddenCount: 0,
      repeatedAncestorIds: new Set(),
    };

  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  const partners = new Map<string, string[]>();
  for (const relation of relationships) {
    if (relation.kind === 'partner') {
      addToMap(partners, relation.fromId, relation.toId);
      addToMap(partners, relation.toId, relation.fromId);
    } else {
      addToMap(parents, relation.toId, relation.fromId);
      addToMap(children, relation.fromId, relation.toId);
    }
  }

  const candidates = new Set([root]);
  const add = (id: string) => {
    if (peopleById.has(id)) candidates.add(id);
  };
  for (const id of partners.get(root) ?? []) add(id);
  const ancestorVisits = new Map<string, Set<string>>();
  const repeatedAncestorIds = new Set<string>();

  const directions = [
    {
      index: parents,
      depth: ancestorDepth,
      trackAncestors: true,
      frontier: [root],
      visited: new Set([root]),
    },
    {
      index: children,
      depth: descendantDepth,
      trackAncestors: false,
      frontier: [root],
      visited: new Set([root]),
    },
  ];
  for (let generation = 0; generation < 3; generation += 1) {
    for (const direction of directions) {
      if (generation >= Math.max(0, direction.depth)) continue;
      const next: string[] = [];
      for (const id of direction.frontier) {
        for (const relative of direction.index.get(id) ?? []) {
          if (!peopleById.has(relative)) continue;
          add(relative);
          if (direction.trackAncestors) {
            const reachedFrom = ancestorVisits.get(relative) ?? new Set<string>();
            reachedFrom.add(id);
            ancestorVisits.set(relative, reachedFrom);
            if (reachedFrom.size > 1) repeatedAncestorIds.add(relative);
          }
          if (!direction.visited.has(relative)) {
            direction.visited.add(relative);
            next.push(relative);
          }
        }
      }
      direction.frontier = next;
    }
  }
  for (const id of [...candidates]) {
    for (const partner of partners.get(id) ?? []) add(partner);
  }

  const ids = [...candidates].slice(0, Math.max(1, Math.min(MAX_VISIBLE_PEOPLE, limit)));
  const visible = new Set(ids);
  return {
    people: ids.map((id) => peopleById.get(id)!),
    relationships: relationships.filter(
      (relation) => visible.has(relation.fromId) && visible.has(relation.toId),
    ),
    selectedId: root,
    hiddenCount: candidates.size - ids.length,
    repeatedAncestorIds,
  };
}

interface LayoutGraph {
  id: string;
  layoutOptions: Record<string, string>;
  children: { id: string; width: number; height: number }[];
  edges: { id: string; sources: string[]; targets: string[] }[];
}

export function buildLayoutGraph(branch: BranchProjection): {
  graph: LayoutGraph;
  membersByGroup: Map<string, Person[]>;
} {
  const groupById = new Map(branch.people.map((person) => [person.id, person.id]));
  function find(id: string): string {
    const parent = groupById.get(id) ?? id;
    if (parent === id) return id;
    const group = find(parent);
    groupById.set(id, group);
    return group;
  }
  for (const relation of branch.relationships) {
    if (relation.kind === 'partner') groupById.set(find(relation.toId), find(relation.fromId));
  }
  const membersByGroup = new Map<string, Person[]>();
  for (const person of branch.people) {
    const group = find(person.id);
    const members = membersByGroup.get(group) ?? [];
    members.push(person);
    membersByGroup.set(group, members);
  }
  const children = [...membersByGroup].map(([id, people]) => ({
    id,
    width: people.length * NODE_WIDTH + Math.max(0, people.length - 1) * PARTNER_GAP,
    height: NODE_HEIGHT,
  }));
  const edges = branch.relationships
    .filter((relation) => relation.kind !== 'partner')
    .filter((relation) => find(relation.fromId) !== find(relation.toId))
    .map((relation) => ({
      id: relation.id,
      sources: [find(relation.fromId)],
      targets: [find(relation.toId)],
    }));

  return {
    graph: {
      id: 'family-layout',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'DOWN',
        'elk.spacing.nodeNode': '64',
        'elk.layered.spacing.nodeNodeBetweenLayers': '92',
        'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      },
      children,
      edges,
    },
    membersByGroup,
  };
}

export function groupPositions(
  membersByGroup: Map<string, Person[]>,
  groups: ReadonlyArray<{ id: string; x?: number; y?: number }>,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  for (const group of groups) {
    const members = membersByGroup.get(group.id) ?? [];
    members.forEach((person, index) =>
      positions.set(person.id, {
        x: (group.x ?? 0) + index * (NODE_WIDTH + PARTNER_GAP),
        y: group.y ?? 0,
      }),
    );
  }
  return positions;
}
