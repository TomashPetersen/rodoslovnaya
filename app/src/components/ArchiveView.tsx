import { useRef, useState } from 'react';
import type { FamilyProject, Media, Story, TrashGroup } from '../domain/types';
import type { BackupStatus } from '../storage/repository';
import { getActiveRecords } from '../domain/model';
import { statusLabels, sizeLabel } from './editor-common';

interface Props {
  project: FamilyProject;
  projects: FamilyProject[];
  disabled: boolean;
  busy: boolean;
  onProject: (id: string) => void;
  onRename: () => void;
  backup?: BackupStatus;
  onConfirmBackup: (confirmed: boolean) => void;
  onBackup: () => void;
  onEmergency: () => void;
  onImport: (file: File) => void;
  onPersist: () => void;
  protectedMode: boolean;
  onRestore: (group: TrashGroup) => void;
  onPurge: (media: Media) => void;
  onShorten: (group: TrashGroup) => void;
  peopleIds: string[];
  mediaIds: string[];
  storyIds: string[];
  onPeople: (ids: string[]) => void;
  onMedia: (ids: string[]) => void;
  onStories: (ids: string[]) => void;
  candidates: { media: Media[]; stories: Story[]; excludedPdfCount: number };
  onEditMaterial: (kind: 'media' | 'story', entry: Media | Story) => void;
  edition: string;
  editionCurrent: boolean;
  onPreview: () => void;
  onEditionDownload: () => void;
}

export default function ArchiveView(props: Props) {
  const [tab, setTab] = useState<'backup' | 'edition' | 'trash'>('backup');
  const frame = useRef<HTMLIFrameElement>(null);
  const { project, disabled, busy, candidates } = props;
  const active = getActiveRecords(project);
  const title = (group: TrashGroup) => {
    if (group.kind === 'person') return project.people.find((p) => p.id === group.entityId)?.name;
    if (group.kind === 'media') {
      const media = project.media.find((m) => m.id === group.entityId);
      return media?.caption || media?.name;
    }
    if (group.kind === 'story') return project.stories.find((s) => s.id === group.entityId)?.title;
    const rel = project.relationships.find((r) => r.id === group.entityId);
    return rel
      ? `${project.people.find((p) => p.id === rel.fromId)?.name} → ${project.people.find((p) => p.id === rel.toId)?.name}`
      : 'Связь';
  };
  const kindLabels = {
    person: 'Человек и его связи',
    relationship: 'Связь',
    media: 'Фото или документ',
    story: 'Рассказ',
  };
  return (
    <main className="content-page archive-page">
      <div className="section-heading">
        <div>
          <span className="eyebrow">СОХРАНИТЬ И ПЕРЕДАТЬ</span>
          <h2>Ваш семейный архив</h2>
        </div>
        <button disabled={disabled} onClick={props.onRename}>
          Переименовать архив
        </button>
      </div>
      <div className="archive-selector">
        <label>
          Открытый архив
          <select
            aria-label="Открытый архив"
            value={project.id}
            disabled={busy}
            onChange={(event) => props.onProject(event.target.value)}
          >
            {props.projects.map((item) => (
              <option value={item.id} key={item.id}>
                {item.id === project.id ? project.title : item.title}
              </option>
            ))}
          </select>
        </label>
        {project.restoredFrom && (
          <p className="muted">
            Независимая копия от {new Date(project.restoredFrom.createdAt).toLocaleString('ru-RU')}.
            Изменения других архивов сюда не попадут.
          </p>
        )}
      </div>
      <div className="archive-tabs" aria-label="Действия с архивом">
        <button aria-pressed={tab === 'backup'} onClick={() => setTab('backup')}>
          Копии
        </button>
        <button aria-pressed={tab === 'edition'} onClick={() => setTab('edition')}>
          Семейный выпуск
        </button>
        <button aria-pressed={tab === 'trash'} onClick={() => setTab('trash')}>
          Корзина
        </button>
      </div>
      {tab === 'backup' && (
        <div className="transfer-grid">
          <section className="transfer-card">
            <h3>Полная резервная копия</h3>
            <p>
              Все люди, связи, рассказы, корзина и оригиналы. Сохраните файл вне приложения для
              восстановления или переноса.
            </p>
            <button
              className="primary"
              disabled={busy || props.protectedMode}
              onClick={props.onBackup}
            >
              Скачать полную копию
            </button>
            {props.protectedMode && (
              <p className="field-error">
                Архив превышает пределы полной копии. Сначала извлеките сохраненные сведения и
                уменьшите объем.
              </p>
            )}
            {props.backup && (
              <div className="backup-status">
                <p>
                  Сформирована: {new Date(props.backup.createdAt).toLocaleString('ru-RU')}.<br />
                  Изменений после копии: {Math.max(0, project.revision - props.backup.revision)}.
                </p>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={props.backup.confirmed}
                    disabled={busy}
                    onChange={(event) => props.onConfirmBackup(event.target.checked)}
                  />
                  Файл сохранен вне приложения
                </label>
                <small>
                  {props.backup.verifiedAt
                    ? `Восстановление этой копии проверено: ${new Date(props.backup.verifiedAt).toLocaleString('ru-RU')}`
                    : 'Восстановление этой копии еще не проверено.'}
                </small>
              </div>
            )}
            <p className="small-note">
              Копия содержит все личные сведения, в том числе корзину. Файл не зашифрован и не
              подходит для выборочной передачи семье.
            </p>
            <button onClick={props.onEmergency} disabled={busy}>
              Скачать сохраненные данные
            </button>
            <button className="text-button" onClick={props.onPersist} disabled={busy}>
              Запросить устойчивое хранение
            </button>
          </section>
          <section className="transfer-card">
            <h3>Восстановить из копии</h3>
            <p>
              После проверки появится независимый архив. Существующие данные останутся на месте.
            </p>
            <label className={`button ${disabled ? 'disabled' : ''}`}>
              Выбрать файл копии
              <input
                className="sr-only"
                aria-label="Восстановить из копии"
                type="file"
                accept=".zip,application/zip"
                disabled={disabled}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) props.onImport(file);
                }}
              />
            </label>
            <p className="small-note">
              Сохранение в браузере зависит от устройства, адреса и профиля. Внешняя копия нужна
              даже при работе без интернета.
            </p>
          </section>
        </div>
      )}
      {tab === 'trash' && (
        <section className="trash-list">
          <h3>Корзина</h3>
          <p className="muted">
            Удаленное не видно в дереве и выпуске, но хранится в полной копии. Восстанавливаются
            согласованные группы.
          </p>
          {project.trash.length === 0 && <p>Корзина пуста.</p>}
          {project.trash.map((group) => (
            <article className="trash-item" key={group.id}>
              <div>
                <small>{kindLabels[group.kind]}</small>
                <h4>{title(group)}</h4>
                <p className="muted">
                  Удалено: {new Date(group.deletedAt).toLocaleString('ru-RU')}
                  {group.relationshipIds.length
                    ? `. Связей в группе: ${group.relationshipIds.length}`
                    : ''}
                </p>
              </div>
              <div className="inline-actions">
                <button
                  disabled={disabled || props.protectedMode}
                  onClick={() => props.onRestore(group)}
                >
                  Восстановить
                </button>
                {props.protectedMode && (
                  <button disabled={disabled} onClick={() => props.onShorten(group)}>
                    Сократить текст
                  </button>
                )}
                {group.kind === 'media' && (
                  <button
                    className="danger"
                    disabled={disabled}
                    onClick={() => {
                      const media = project.media.find((m) => m.id === group.entityId);
                      if (media) props.onPurge(media);
                    }}
                  >
                    Удалить файл навсегда
                  </button>
                )}
              </div>
            </article>
          ))}
        </section>
      )}
      {tab === 'edition' && (
        <section className="edition-builder">
          <h3>Семейный выпуск</h3>
          <p className="muted">
            Выберите людей, фотографии и рассказы. Упоминания в текстах и люди на снимках требуют
            вашей проверки. PDF и оригиналы в выпуск не входят.
          </p>
          <div className="edition-columns">
            <section>
              <h4>Люди</h4>
              <div className="selection-list">
                {active.people.map((person) => (
                  <label className="checkbox-row" key={person.id}>
                    <input
                      type="checkbox"
                      checked={props.peopleIds.includes(person.id)}
                      disabled={busy}
                      onChange={(event) =>
                        props.onPeople(
                          event.target.checked
                            ? [...props.peopleIds, person.id]
                            : props.peopleIds.filter((id) => id !== person.id),
                        )
                      }
                    />
                    <span>
                      {person.name}
                      <small>{statusLabels[person.lifeStatus]}</small>
                    </span>
                  </label>
                ))}
              </div>
              {!active.people.length && <p>Добавьте первого человека, чтобы подготовить выпуск.</p>}
            </section>
            <section>
              <h4>Фотографии и рассказы</h4>
              <p className="muted">
                Изначально материалы не выбраны. Исключенных документов:{' '}
                {candidates.excludedPdfCount}.
              </p>
              <button
                disabled={busy || !props.peopleIds.length}
                onClick={() => {
                  props.onMedia(candidates.media.map((m) => m.id));
                  props.onStories(candidates.stories.map((s) => s.id));
                }}
              >
                Выбрать все подходящие
              </button>
              <div className="selection-list">
                {candidates.media.map((item) => (
                  <label className="checkbox-row" key={item.id}>
                    <input
                      type="checkbox"
                      checked={props.mediaIds.includes(item.id)}
                      disabled={busy}
                      onChange={(event) =>
                        props.onMedia(
                          event.target.checked
                            ? [...props.mediaIds, item.id]
                            : props.mediaIds.filter((id) => id !== item.id),
                        )
                      }
                    />
                    {item.caption || item.name}
                  </label>
                ))}
                {candidates.stories.map((item) => (
                  <label className="checkbox-row" key={item.id}>
                    <input
                      type="checkbox"
                      checked={props.storyIds.includes(item.id)}
                      disabled={busy}
                      onChange={(event) =>
                        props.onStories(
                          event.target.checked
                            ? [...props.storyIds, item.id]
                            : props.storyIds.filter((id) => id !== item.id),
                        )
                      }
                    />
                    {item.title}
                  </label>
                ))}
              </div>
              <details>
                <summary>Почему другие материалы недоступны</summary>
                {active.media
                  .filter(
                    (item) =>
                      item.mime !== 'application/pdf' &&
                      !candidates.media.some((m) => m.id === item.id),
                  )
                  .map((item) => (
                    <p key={item.id}>
                      {item.caption || item.name}:{' '}
                      {item.peopleIds.length
                        ? 'выбраны не все участники или участник в корзине'
                        : 'нет участников'}
                      .{' '}
                      <button
                        className="text-button"
                        disabled={disabled}
                        onClick={() => props.onEditMaterial('media', item)}
                      >
                        Изменить участников
                      </button>
                    </p>
                  ))}
                {active.stories
                  .filter((item) => !candidates.stories.some((s) => s.id === item.id))
                  .map((item) => (
                    <p key={item.id}>
                      {item.title}:{' '}
                      {item.peopleIds.length
                        ? 'выбраны не все участники или участник в корзине'
                        : 'нет участников'}
                      .{' '}
                      <button
                        className="text-button"
                        disabled={disabled}
                        onClick={() => props.onEditMaterial('story', item)}
                      >
                        Изменить участников
                      </button>
                    </p>
                  ))}
              </details>
            </section>
          </div>
          <div className="edition-actions">
            <button disabled={busy || !props.peopleIds.length} onClick={props.onPreview}>
              Предварительный просмотр
            </button>
            {props.edition && (
              <>
                <button
                  className="primary"
                  disabled={busy || !props.editionCurrent}
                  onClick={props.onEditionDownload}
                >
                  Скачать выпуск HTML
                </button>
                <button
                  disabled={busy || !props.editionCurrent}
                  onClick={() => frame.current?.contentWindow?.print()}
                >
                  Печать выпуска
                </button>
              </>
            )}
          </div>
          {props.edition && !props.editionCurrent && (
            <p role="alert">Архив или состав изменился. Обновите предварительный просмотр.</p>
          )}
          {props.edition && (
            <iframe
              className="edition-preview"
              ref={frame}
              title="Предварительный просмотр семейного выпуска"
              sandbox="allow-same-origin allow-modals"
              srcDoc={props.edition}
            />
          )}
        </section>
      )}
    </main>
  );
}

export function EmergencyFiles({
  project,
  files,
  onDownload,
}: {
  project: FamilyProject;
  files: { id: string; original: Blob }[];
  onDownload: (blob: Blob, name: string) => void;
}) {
  return (
    <>
      <p>
        Это аварийное извлечение отдельных файлов, а не копия с автоматическим восстановлением.
        Текущий несохраненный ввод сюда не входит.
      </p>
      <button
        onClick={() =>
          onDownload(
            new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }),
            'rodoslovnaya-svedeniya.json',
          )
        }
      >
        Скачать сведения JSON
      </button>
      <ul className="emergency-files">
        {files.map((file) => {
          const media = project.media.find((m) => m.id === file.id);
          return (
            <li key={file.id}>
              <span>
                {media?.name} · {sizeLabel(file.original.size)}
              </span>
              <button onClick={() => onDownload(file.original, media?.name || file.id)}>
                Скачать оригинал
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
