import type { FamilyProject, Person, Relationship } from '../domain/types';
import { getActiveRecords } from '../domain/model';
import {
  dateLabel,
  Portrait,
  statusLabels,
  type FieldDraft,
  type PersonField,
} from './editor-common';

interface Props {
  project: FamilyProject;
  person: Person;
  urls: Record<string, string>;
  disabled: boolean;
  drafts: Record<string, FieldDraft>;
  onField: (field: PersonField, value: string) => void;
  onReset: (field: PersonField) => void;
  onBack: () => void;
  onRelative: () => void;
  onFile: (file: File) => void;
  onStory: () => void;
  onMaterials: () => void;
  onDelete: () => void;
  onSelect: (id: string) => void;
  onRelation: (relationship: Relationship) => void;
  onDeleteRelation: (relationship: Relationship) => void;
  onPortrait: (id?: string) => void;
}

export default function PersonEditor(props: Props) {
  const { project, person, urls, disabled, drafts, onField, onReset } = props;
  const active = getActiveRecords(project);
  function field(name: PersonField, label: string, multiline = false, hint?: string) {
    const draft = drafts[`${person.id}:${name}`];
    const shared = {
      value: draft?.value ?? person[name],
      disabled,
      'aria-label': label,
      'aria-invalid': !!draft?.error,
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        onField(name, event.target.value),
    };
    return (
      <div className="field-editor">
        <label>
          {label}
          {multiline ? (
            <textarea {...shared} rows={3} />
          ) : (
            <input {...shared} maxLength={name === 'name' ? 200 : undefined} />
          )}
        </label>
        {hint && <small>{hint}</small>}
        {draft?.error && (
          <>
            <p className="field-error" role="alert">
              {draft.error}
            </p>
            <button type="button" className="text-button" onClick={() => onReset(name)}>
              Вернуть сохраненное значение
            </button>
          </>
        )}
      </div>
    );
  }
  return (
    <aside className="person-panel" aria-label="Карточка человека">
      <button className="mobile-back text-button" onClick={props.onBack}>
        ← Назад
      </button>
      <div className="profile-head">
        <Portrait person={person} project={project} urls={urls} />
        <div>
          <h2>{person.name}</h2>
          <p className="profile-dates">
            {person.birthDate ? dateLabel(person.birthDate) : 'Дата рождения не указана'}
            {person.deathDate && <span>Дата смерти {dateLabel(person.deathDate)}</span>}
          </p>
        </div>
      </div>
      <button
        className="primary profile-primary-action"
        disabled={disabled}
        onClick={props.onRelative}
      >
        Добавить родственника
      </button>
      <fieldset disabled={disabled} className="profile-fields">
        {field('name', 'Имя и фамилия')}
        <label>
          Статус жизни
          <select
            value={person.lifeStatus}
            onChange={(event) => onField('lifeStatus', event.target.value)}
          >
            {Object.entries(statusLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <div className="field-pair">
          {field('birthDate', 'Дата рождения')}
          {field('deathDate', 'Дата смерти')}
        </div>
        <small>Год, ГГГГ-ММ или ГГГГ-ММ-ДД. Знак ~ означает «около».</small>
      </fieldset>
      <section className="panel-materials" aria-label="Материалы человека">
        <h3>Материалы человека</h3>
        <div className="panel-actions">
          <label className={`button ${disabled ? 'disabled' : ''}`}>
            Добавить фото или документ
            <input
              className="sr-only"
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              aria-label="Добавить фото или документ"
              disabled={disabled}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) props.onFile(file);
              }}
            />
          </label>
          <button disabled={disabled} onClick={props.onStory}>
            Написать историю
          </button>
          <button onClick={props.onMaterials}>Фотографии и истории</button>
        </div>
      </section>
      <details className="person-details">
        <summary>Другие сведения</summary>
        <fieldset disabled={disabled} className="profile-fields">
          {field('birthPlace', 'Место рождения')}
          {field('biography', 'Что известно о человеке', true)}
          {field('source', 'Откуда эти сведения', true)}
          <label>
            Портрет
            <select
              value={
                person.portraitId &&
                !project.trash.some(
                  (group) => group.kind === 'media' && group.entityId === person.portraitId,
                )
                  ? person.portraitId
                  : ''
              }
              onChange={(event) => props.onPortrait(event.target.value || undefined)}
            >
              <option value="">Без портрета</option>
              {active.media
                .filter(
                  (item) => item.mime.startsWith('image/') && item.peopleIds.includes(person.id),
                )
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.caption || item.name}
                  </option>
                ))}
            </select>
          </label>
        </fieldset>
      </details>
      <div className="relationships">
        <h3>Родственники</h3>
        {active.relationships
          .filter((rel) => rel.fromId === person.id || rel.toId === person.id)
          .map((rel) => {
            const other = active.people.find(
              (p) => p.id === (rel.fromId === person.id ? rel.toId : rel.fromId),
            )!;
            return (
              <div className="relationship-item" key={rel.id}>
                <button onClick={() => props.onSelect(other.id)}>
                  <small>
                    {rel.kind === 'partner'
                      ? rel.status === 'separated'
                        ? 'Бывший партнер'
                        : 'Партнер'
                      : rel.fromId === person.id
                        ? rel.kind === 'adoptive'
                          ? 'Приемный ребенок'
                          : 'Ребенок'
                        : rel.kind === 'adoptive'
                          ? 'Приемный родитель'
                          : 'Родитель'}
                  </small>
                  {other.name}
                </button>
                <div className="inline-actions">
                  <button
                    className="text-button"
                    disabled={disabled}
                    onClick={() => props.onRelation(rel)}
                    aria-label={`Изменить связь с ${other.name}`}
                  >
                    Изменить
                  </button>
                  <button
                    className="text-button danger"
                    disabled={disabled}
                    onClick={() => props.onDeleteRelation(rel)}
                    aria-label={`Удалить связь с ${other.name}`}
                  >
                    Удалить связь
                  </button>
                </div>
              </div>
            );
          })}
        {!active.relationships.some(
          (rel) => rel.fromId === person.id || rel.toId === person.id,
        ) && <p className="muted">Добавьте первого родственника.</p>}
      </div>
      <button className="text-button danger" disabled={disabled} onClick={props.onDelete}>
        Удалить человека в корзину
      </button>
    </aside>
  );
}
