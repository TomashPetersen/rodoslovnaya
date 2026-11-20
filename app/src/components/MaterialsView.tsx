import type { FamilyProject, Media, Story } from '../domain/types';
import { getActiveRecords, isDeleted } from '../domain/model';

interface Props {
  project: FamilyProject;
  filter: string;
  onFilter: (id: string) => void;
  urls: Record<string, string>;
  disabled: boolean;
  onFile: (file: File, personId: string) => void;
  onStory: (personId?: string) => void;
  onEdit: (kind: 'media' | 'story', entry: Media | Story) => void;
  onDelete: (kind: 'media' | 'story', id: string) => void;
  onOpen: (media: Media) => void;
  onCaption: (media: Media, value: string) => void;
  captionDrafts: Record<string, { value: string; error: string }>;
  onResetCaption: (id: string) => void;
  onBack?: () => void;
}

export default function MaterialsView(props: Props) {
  const { project, filter, urls, disabled } = props;
  const active = getActiveRecords(project);
  const media = active.media.filter((item) => !filter || item.peopleIds.includes(filter));
  const stories = active.stories.filter((item) => !filter || item.peopleIds.includes(filter));
  const names = (ids: string[]) =>
    ids
      .map((id) => {
        const p = project.people.find((p) => p.id === id);
        return `${p?.name ?? ''}${isDeleted(project, 'person', id) ? ' (в корзине)' : ''}`;
      })
      .join(', ') || 'Без участников';
  return (
    <main className="content-page">
      {props.onBack && (
        <button className="text-button page-back" onClick={props.onBack}>
          ← К карточке
        </button>
      )}
      <div className="section-heading">
        <div>
          <span className="eyebrow">ФОТОГРАФИИ И РАССКАЗЫ</span>
          <h2>Семейные материалы</h2>
        </div>
      </div>
      <div className="material-toolbar">
        <label>
          Показать
          <select
            aria-label="Фильтр материалов"
            value={filter}
            onChange={(event) => props.onFilter(event.target.value)}
          >
            <option value="">Все материалы</option>
            {active.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className={`button ${disabled || !filter ? 'disabled' : ''}`}>
          Фото или документ
          <input
            className="sr-only"
            aria-label="Добавить фото или документ"
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            disabled={disabled || !filter}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) props.onFile(file, filter);
            }}
          />
        </label>
        <button disabled={disabled} onClick={() => props.onStory(filter || undefined)}>
          Написать историю
        </button>
      </div>
      <p className="muted">
        Оригиналы сохраняются без изменения. JPEG, PNG, WebP и PDF, до 25 МиБ на файл.
        {!filter && ' Для добавления фотографии выберите человека.'}
      </p>
      <div className="media-grid">
        {media.map((item) => (
          <article className="media-card" key={item.id}>
            <button
              className="media-open"
              onClick={() => props.onOpen(item)}
              aria-label={`Открыть материал: ${item.caption || item.name}`}
            >
              {urls[item.id] ? (
                <img src={urls[item.id]} alt={item.caption || 'Семейная фотография'} />
              ) : (
                <span className="document-placeholder">
                  PDF<span>Открыть документ</span>
                </span>
              )}
            </button>
            <div className="media-caption">
              <label>
                Подпись
                <input
                  aria-label={`Подпись ${item.name}`}
                  value={props.captionDrafts[item.id]?.value ?? item.caption}
                  disabled={disabled}
                  onChange={(event) => props.onCaption(item, event.target.value)}
                />
              </label>
              {props.captionDrafts[item.id]?.error && (
                <>
                  <p role="alert" className="field-error">
                    {props.captionDrafts[item.id].error}
                  </p>
                  <button className="text-button" onClick={() => props.onResetCaption(item.id)}>
                    Вернуть сохраненное значение
                  </button>
                </>
              )}
              <p>{names(item.peopleIds)}</p>
              <div className="inline-actions">
                <button
                  className="text-button"
                  disabled={disabled}
                  onClick={() => props.onEdit('media', item)}
                >
                  Изменить участников и подпись
                </button>
                <button
                  className="text-button danger"
                  disabled={disabled}
                  onClick={() => props.onDelete('media', item.id)}
                >
                  В корзину
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
      <div className="stories">
        {stories.map((story) => (
          <article className="story-card" key={story.id}>
            <span className="eyebrow">СЕМЕЙНАЯ ИСТОРИЯ</span>
            <h3>{story.title}</h3>
            <p>{story.text}</p>
            <small>{names(story.peopleIds)}</small>
            <div className="inline-actions">
              <button disabled={disabled} onClick={() => props.onEdit('story', story)}>
                Изменить историю
              </button>
              <button
                className="text-button danger"
                disabled={disabled}
                onClick={() => props.onDelete('story', story.id)}
              >
                В корзину
              </button>
            </div>
          </article>
        ))}
      </div>
      {!media.length && !stories.length && (
        <div className="empty-state compact">
          <h3>Здесь будут воспоминания</h3>
          <p>Добавьте фотографию или напишите первую историю.</p>
        </div>
      )}
    </main>
  );
}
