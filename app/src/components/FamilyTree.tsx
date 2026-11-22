import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getSmoothStepPath,
  getStraightPath,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
  type Viewport,
} from '@xyflow/react';
import ELK from 'elkjs/lib/elk-api';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import type { FamilyProject, Person } from '../domain/types';
import {
  buildLayoutGraph,
  groupPositions,
  NODE_HEIGHT,
  NODE_WIDTH,
  projectBranch,
  type BranchProjection,
} from './tree-layout';
import '@xyflow/react/dist/style.css';
import './family-tree.css';

type PersonNode = Node<
  {
    person: Person;
    active: boolean;
    repeated: boolean;
    onSelect: (id: string) => void;
  },
  'person'
>;

function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toLocaleUpperCase('ru');
}

function PersonCard({ data }: NodeProps<PersonNode>) {
  const { person, active, repeated } = data;
  const dates = person.deathDate
    ? `${person.birthDate || '?'} - ${person.deathDate}`
    : person.birthDate || 'Дата рождения не указана';
  return (
    <div className="tree-person-frame">
      <Handle id="parent-in" type="target" position={Position.Top} isConnectable={false} />
      <Handle id="child-out" type="source" position={Position.Bottom} isConnectable={false} />
      <Handle
        id="partner-left-source"
        type="source"
        position={Position.Left}
        isConnectable={false}
      />
      <Handle
        id="partner-left-target"
        type="target"
        position={Position.Left}
        isConnectable={false}
      />
      <Handle
        id="partner-right-source"
        type="source"
        position={Position.Right}
        isConnectable={false}
      />
      <Handle
        id="partner-right-target"
        type="target"
        position={Position.Right}
        isConnectable={false}
      />
      <button
        type="button"
        className={`tree-person nodrag${active ? ' tree-person-active' : ''}`}
        onClick={() => data.onSelect(person.id)}
        aria-label={`Открыть карточку: ${person.name}`}
        aria-pressed={active}
      >
        <span className="tree-person-initials" aria-hidden="true">
          {initials(person.name) || '?'}
        </span>
        <span className="tree-person-details">
          <strong title={person.name}>{person.name}</strong>
          <span className="tree-person-dates">{dates}</span>
          {repeated && <span className="tree-person-repeat">Общий предок</span>}
        </span>
      </button>
    </div>
  );
}

const nodeTypes = { person: PersonCard };

type RelationshipEdge = Edge<{ partner: boolean }, 'relationship'>;

function RelationshipLine(props: EdgeProps<RelationshipEdge>) {
  const [path, x, y] = props.data?.partner ? getStraightPath(props) : getSmoothStepPath(props);
  return (
    <>
      <BaseEdge id={props.id} path={path} style={props.style} />
      <EdgeLabelRenderer>
        <span
          className="tree-edge-label"
          style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
        >
          {props.label}
        </span>
      </EdgeLabelRenderer>
    </>
  );
}

const edgeTypes = { relationship: RelationshipLine };

function edgesForBranch(
  branch: BranchProjection,
  positions: Map<string, { x: number; y: number }>,
): RelationshipEdge[] {
  return branch.relationships.map((relation) => {
    const isPartner = relation.kind === 'partner';
    const pointsRight =
      (positions.get(relation.fromId)?.x ?? 0) <= (positions.get(relation.toId)?.x ?? 0);
    const label = isPartner
      ? relation.status === 'separated'
        ? 'Бывшие партнеры'
        : 'Партнеры'
      : relation.kind === 'adoptive'
        ? 'Приемное родительство'
        : 'Биологическое родительство';
    return {
      id: relation.id,
      source: relation.fromId,
      target: relation.toId,
      sourceHandle: isPartner ? `partner-${pointsRight ? 'right' : 'left'}-source` : 'child-out',
      targetHandle: isPartner ? `partner-${pointsRight ? 'left' : 'right'}-target` : 'parent-in',
      type: 'relationship',
      data: { partner: isPartner },
      className: `tree-edge-${relation.kind}`,
      label,
      style: {
        stroke: isPartner ? 'var(--partner-line)' : 'var(--control-border)',
        strokeWidth: 2,
        strokeDasharray: relation.kind === 'adoptive' ? '6 4' : undefined,
      },
      focusable: false,
      selectable: false,
      deletable: false,
    };
  });
}

export interface TreeViewState {
  ancestorDepth: number;
  descendantDepth: number;
  viewport?: Viewport;
  focusId?: string | null;
}

interface Props {
  project: FamilyProject;
  selectedId: string | null;
  onSelect: (id: string) => void;
  viewState?: TreeViewState;
  onViewStateChange?: (state: TreeViewState) => void;
}

interface LayoutState {
  branch: BranchProjection;
  nodes: PersonNode[];
  edges: Edge[];
  error?: string;
}

export default function FamilyTree({
  project,
  selectedId,
  onSelect,
  viewState,
  onViewStateChange,
}: Props) {
  const [ancestorDepth, setAncestorDepth] = useState(viewState?.ancestorDepth ?? 1);
  const [descendantDepth, setDescendantDepth] = useState(viewState?.descendantDepth ?? 1);
  const savedView = useRef<TreeViewState>(viewState ?? { ancestorDepth: 1, descendantDepth: 1 });
  useEffect(() => {
    if (!viewState) return;
    savedView.current = viewState;
    setAncestorDepth(viewState.ancestorDepth);
    setDescendantDepth(viewState.descendantDepth);
  }, [viewState]);
  const onViewRef = useRef(onViewStateChange);
  useEffect(() => {
    onViewRef.current = onViewStateChange;
  }, [onViewStateChange]);
  const [layout, setLayout] = useState<LayoutState | null>(null);
  const [attempt, setAttempt] = useState(0);
  const flow = useRef<ReactFlowInstance<PersonNode, Edge> | null>(null);
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  const branch = useMemo(
    () =>
      projectBranch(
        { people: project.people, relationships: project.relationships, trash: project.trash },
        selectedId,
        ancestorDepth,
        descendantDepth,
      ),
    [
      project.people,
      project.relationships,
      project.trash,
      selectedId,
      ancestorDepth,
      descendantDepth,
    ],
  );

  useEffect(() => {
    let active = true;
    let engine: InstanceType<typeof ELK> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: () => void = () => undefined;
    async function placeBranch() {
      try {
        let workerFailure: (reason: Error) => void = () => undefined;
        const workerError = new Promise<never>((_, reject) => {
          workerFailure = reject;
        });
        engine = new ELK({
          workerFactory: () => {
            const worker = new Worker(elkWorkerUrl);
            worker.onerror = () => workerFailure(new Error('Не удалось запустить расчет дерева.'));
            return worker;
          },
        });
        const { graph, membersByGroup } = buildLayoutGraph(branch);
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Расчет дерева превысил время ожидания.')),
            15_000,
          );
        });
        const cancellation = new Promise<never>((_, reject) => {
          cancel = () => reject(new Error('Расчет дерева отменен.'));
        });
        const result = await Promise.race([
          engine.layout(graph),
          workerError,
          timeout,
          cancellation,
        ]);
        if (!active) return;
        const positions = groupPositions(membersByGroup, result.children ?? []);
        const nodes: PersonNode[] = branch.people.map((person) => ({
          id: person.id,
          type: 'person',
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          position: positions.get(person.id) ?? { x: 0, y: 0 },
          draggable: false,
          connectable: false,
          deletable: false,
          focusable: false,
          data: {
            person,
            active: person.id === branch.selectedId,
            repeated: branch.repeatedAncestorIds.has(person.id),
            onSelect: (id: string) => onSelectRef.current(id),
          },
        }));
        setLayout({ branch, nodes, edges: edgesForBranch(branch, positions) });
      } catch {
        if (active)
          setLayout({
            branch,
            nodes: [],
            edges: [],
            error:
              'Не удалось разместить дерево. Сведения сохранены; карточки доступны в списке людей.',
          });
      } finally {
        clearTimeout(timer);
        engine?.terminateWorker();
      }
    }
    void placeBranch();
    return () => {
      active = false;
      cancel();
      clearTimeout(timer);
      engine?.terminateWorker();
    };
  }, [branch, attempt]);

  const current = layout?.branch === branch ? layout : null;
  useEffect(() => {
    if (!current || current.error) return;
    const frame = requestAnimationFrame(() => {
      if (savedView.current.focusId === current.branch.selectedId && savedView.current.viewport) {
        void flow.current?.setViewport(savedView.current.viewport);
      } else {
        void flow.current?.fitView({ padding: 0.22, maxZoom: 1 });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [current]);

  function changeDepth(direction: 'ancestor' | 'descendant', value: number) {
    if (direction === 'ancestor') setAncestorDepth(value);
    else setDescendantDepth(value);
    savedView.current = {
      ancestorDepth: direction === 'ancestor' ? value : ancestorDepth,
      descendantDepth: direction === 'descendant' ? value : descendantDepth,
      focusId: branch.selectedId,
    };
    onViewRef.current?.(savedView.current);
  }

  function focusSelected() {
    const node = current?.nodes.find((candidate) => candidate.id === branch.selectedId);
    if (node)
      void flow.current?.setCenter(
        node.position.x + NODE_WIDTH / 2,
        node.position.y + NODE_HEIGHT / 2,
        { zoom: 1 },
      );
  }

  return (
    <ReactFlowProvider>
      <section className="family-tree" aria-label="Дерево выбранной семьи">
        <div className="tree-toolbar">
          <div className="tree-depth-controls">
            <label>
              Предки{' '}
              <select
                aria-label="Поколений предков"
                value={ancestorDepth}
                onChange={(event) => changeDepth('ancestor', Number(event.target.value))}
              >
                <option value={1}>1 поколение</option>
                <option value={2}>2 поколения</option>
                <option value={3}>3 поколения</option>
              </select>
            </label>
            <label>
              Потомки{' '}
              <select
                aria-label="Поколений потомков"
                value={descendantDepth}
                onChange={(event) => changeDepth('descendant', Number(event.target.value))}
              >
                <option value={1}>1 поколение</option>
                <option value={2}>2 поколения</option>
                <option value={3}>3 поколения</option>
              </select>
            </label>
          </div>
          <button
            type="button"
            className="tree-center-button"
            onClick={focusSelected}
            disabled={!current || !!current.error}
          >
            К выбранному человеку
          </button>
        </div>
        <div className="tree-canvas" aria-busy={!current}>
          <ReactFlow<PersonNode, Edge>
            style={{ position: 'absolute', inset: 0, width: 'auto', height: 'auto' }}
            nodes={current?.nodes ?? []}
            edges={current?.edges ?? []}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onInit={(instance) => {
              flow.current = instance;
            }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            deleteKeyCode={null}
            minZoom={0.12}
            maxZoom={1.6}
            onMoveEnd={(_, viewport) => {
              if (!current) return;
              savedView.current = {
                ancestorDepth,
                descendantDepth,
                viewport,
                focusId: branch.selectedId,
              };
              onViewRef.current?.(savedView.current);
            }}
            aria-label="Схема родственных связей"
            ariaLabelConfig={{
              'controls.ariaLabel': 'Масштаб дерева',
              'controls.zoomIn.ariaLabel': 'Увеличить дерево',
              'controls.zoomOut.ariaLabel': 'Уменьшить дерево',
              'controls.fitView.ariaLabel': 'Показать всю ветвь',
              'node.a11yDescription.default': 'Откройте карточку кнопкой с именем человека.',
              'node.a11yDescription.keyboardDisabled':
                'Откройте карточку кнопкой с именем человека.',
              'edge.a11yDescription.default': 'Родственная связь.',
              'handle.ariaLabel': 'Соединение родственной связи',
            }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={24}
              size={1}
              color="var(--grid-dot)"
            />
          </ReactFlow>
          {!current && (
            <p className="tree-message" role="status">
              Размещаем карточки…
            </p>
          )}
          {current?.error && (
            <div className="tree-message tree-error" role="alert">
              <p>{current.error}</p>
              <button type="button" onClick={() => setAttempt((value) => value + 1)}>
                Повторить размещение
              </button>
            </div>
          )}
        </div>
        <div className="tree-viewport-tools">
          <Controls showInteractive={false} orientation="horizontal" aria-label="Масштаб дерева" />
        </div>
        <div className="tree-legend">
          <span>
            <i className="tree-legend-line" /> Биологическое
          </span>
          <span>
            <i className="tree-legend-line tree-legend-adoptive" /> Приемное
          </span>
          <span>
            <i className="tree-legend-line tree-legend-partner" /> Партнерство
          </span>
          <span className="tree-visible-count">На схеме: {branch.people.length}</span>
        </div>
        {branch.hiddenCount > 0 && (
          <p className="tree-limit" role="status">
            Часть ветви скрыта: {branch.hiddenCount}. На схеме показано не более 80 человек.
            Выберите нужную карточку в списке людей, чтобы рассмотреть другую часть семьи.
          </p>
        )}
      </section>
    </ReactFlowProvider>
  );
}
