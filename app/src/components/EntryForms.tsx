import { useState, type FormEvent } from 'react';
import type { FamilyProject, Person, Relationship, Media, Story } from '../domain/types';
import { getActiveRecords } from '../domain/model';
import { PeoplePicker } from './editor-common';

export function NameForm({
  initial = '',
  label = 'Имя и фамилия',
  onSave,
  disabled,
}: {
  initial?: string;
  label?: string;
  disabled: boolean;
  onSave: (name: string) => void;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave(String(new FormData(event.currentTarget).get('name')).trim());
      }}
    >
      <fieldset disabled={disabled} className="form-stack">
        <label>
          {label}
          <input name="name" defaultValue={initial} autoFocus required maxLength={200} />
        </label>
        <button className="primary">Сохранить</button>
      </fieldset>
    </form>
  );
}

export function RelativeForm({
  project,
  person,
  relationship,
  disabled,
  onSave,
}: {
  project: FamilyProject;
  person: Person;
  relationship?: Relationship;
  disabled: boolean;
  onSave: (value: {
    role: 'parent' | 'child' | 'partner';
    mode: 'new' | 'existing';
    name: string;
    otherId: string;
    kind: 'biological' | 'adoptive';
    status: 'together' | 'separated';
  }) => void;
}) {
  const [role, setRole] = useState<'parent' | 'child' | 'partner'>(
    relationship
      ? relationship.kind === 'partner'
        ? 'partner'
        : relationship.toId === person.id
          ? 'parent'
          : 'child'
      : 'parent',
  );
  const [mode, setMode] = useState<'new' | 'existing'>(relationship ? 'existing' : 'new');
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const people = getActiveRecords(project).people.filter((p) => p.id !== person.id);
  const [otherId, setOtherId] = useState(
    relationship
      ? relationship.fromId === person.id
        ? relationship.toId
        : relationship.fromId
      : '',
  );
  const [kind, setKind] = useState<'biological' | 'adoptive'>(
    relationship?.kind === 'adoptive' ? 'adoptive' : 'biological',
  );
  const [status, setStatus] = useState<'together' | 'separated'>(
    relationship?.status ?? 'together',
  );
  const otherName =
    mode === 'new'
      ? name || 'Новый человек'
      : people.find((p) => p.id === otherId)?.name || 'Выбранный человек';
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ role, mode, name: name.trim(), otherId, kind, status });
      }}
    >
      <fieldset disabled={disabled} className="form-stack">
        <p>
          Для: <strong>{person.name}</strong>
        </p>
        <label>
          Кого добавляем
          <select value={role} onChange={(event) => setRole(event.target.value as typeof role)}>
            <option value="parent">Родитель</option>
            <option value="child">Ребенок</option>
            <option value="partner">Партнер</option>
          </select>
        </label>
        {!relationship && (
          <div className="segmented" aria-label="Выбор человека">
            <button type="button" aria-pressed={mode === 'new'} onClick={() => setMode('new')}>
              Новый человек
            </button>
            <button
              type="button"
              aria-pressed={mode === 'existing'}
              onClick={() => setMode('existing')}
            >
              Уже есть в архиве
            </button>
          </div>
        )}
        {mode === 'new' ? (
          <label>
            Имя родственника
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={200}
            />
          </label>
        ) : (
          <>
            <label>
              Найти родственника
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Имя или фамилия"
              />
            </label>
            <label>
              Человек
              <select required value={otherId} onChange={(event) => setOtherId(event.target.value)}>
                <option value="">Выберите человека</option>
                {people
                  .filter(
                    (p) =>
                      p.name.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')) ||
                      p.id === otherId,
                  )
                  .map((p) => (
                    <option value={p.id} key={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
          </>
        )}
        {role !== 'partner' ? (
          <label>
            Родительство
            <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
              <option value="biological">Биологическое</option>
              <option value="adoptive">Приемное</option>
            </select>
          </label>
        ) : (
          <label>
            Отношения
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as typeof status)}
            >
              <option value="together">Вместе</option>
              <option value="separated">Расстались / развод</option>
            </select>
          </label>
        )}
        <p className="relation-preview" role="status">
          {role === 'parent'
            ? `${otherName} - ${kind === 'adoptive' ? 'приемный родитель' : 'родитель'} ${person.name}`
            : role === 'child'
              ? `${person.name} - ${kind === 'adoptive' ? 'приемный родитель' : 'родитель'} ${otherName}`
              : `${person.name} и ${otherName} - ${status === 'separated' ? 'бывшие партнеры' : 'партнеры'}`}
        </p>
        {role === 'partner' && (
          <p className="muted">Партнерство не добавляет родителей ребенку автоматически.</p>
        )}
        <button className="primary">Сохранить</button>
      </fieldset>
    </form>
  );
}

export function MaterialForm({
  project,
  entry,
  personId,
  disabled,
  onSave,
}: {
  project: FamilyProject;
  entry?: Media | Story;
  personId?: string;
  disabled: boolean;
  onSave: (value: { title: string; text: string; caption: string; peopleIds: string[] }) => void;
}) {
  const story = !entry || 'text' in entry;
  const [peopleIds, setPeopleIds] = useState(entry?.peopleIds ?? (personId ? [personId] : []));
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onSave({
      title: String(data.get('title') ?? '').trim(),
      text: String(data.get('text') ?? '').trim(),
      caption: String(data.get('caption') ?? '').trim(),
      peopleIds,
    });
  }
  return (
    <form onSubmit={submit}>
      <fieldset className="form-stack" disabled={disabled}>
        {story ? (
          <>
            <label>
              Название истории
              <input
                name="title"
                defaultValue={entry && 'title' in entry ? entry.title : ''}
                required
                autoFocus
                maxLength={200}
              />
            </label>
            <label>
              Воспоминание
              <textarea
                name="text"
                defaultValue={entry && 'text' in entry ? entry.text : ''}
                rows={7}
                required
                maxLength={50000}
              />
            </label>
          </>
        ) : (
          <label>
            Подпись
            <input name="caption" defaultValue={entry.caption} autoFocus />
          </label>
        )}
        <PeoplePicker project={project} value={peopleIds} onChange={setPeopleIds} />
        <p className="muted">
          Без участников материал останется в общем разделе и не попадет в семейный выпуск.
        </p>
        <button className="primary">Сохранить</button>
      </fieldset>
    </form>
  );
}
