import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { FamilyProject, Person, StoredFile } from '../domain/types';
import { isDeleted } from '../domain/model';

export const statusLabels = { unknown: 'Неизвестно', alive: 'Жив', deceased: 'Умер' };
export const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('');
export const dateLabel = (value: string) => value.replace(/^~/, 'около ');
export const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : 'Операция не завершена. Повторите попытку.';
export const sizeLabel = (bytes: number) =>
  `${(bytes / 1048576).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МиБ`;

export function Modal({
  title,
  children,
  onClose,
  busy = false,
  error = '',
  errorAction,
  operation,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  error?: string;
  errorAction?: ReactNode;
  operation?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <button className="modal-close" aria-label="Закрыть окно" disabled={busy} onClick={onClose}>
        ×
      </button>
      <h2 id={titleId}>{title}</h2>
      {error && (
        <div className="banner error" role="alert">
          {error}
          {errorAction}
        </div>
      )}
      {operation}
      {children}
    </dialog>
  );
}

export function PeoplePicker({
  project,
  value,
  onChange,
  disabled = false,
}: {
  project: FamilyProject;
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="people-picker">
      <legend>Участники</legend>
      <p className="muted">Отметьте всех, кто относится к этому материалу.</p>
      <div className="selection-list">
        {project.people.map((person) => (
          <label className="checkbox-row" key={person.id}>
            <input
              type="checkbox"
              checked={value.includes(person.id)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...value, person.id]
                    : value.filter((id) => id !== person.id),
                )
              }
            />
            {person.name}
            {isDeleted(project, 'person', person.id) && <small>в корзине</small>}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function useFileUrls(files: StoredFile[], originals = false) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    const next: Record<string, string> = {};
    for (const file of files) {
      const blob = originals ? file.original : file.thumbnail;
      if (blob) next[file.id] = URL.createObjectURL(blob);
    }
    setUrls(next);
    return () => {
      Object.values(next).forEach((url) => URL.revokeObjectURL(url));
    };
  }, [files, originals]);
  return urls;
}

export function Portrait({
  person,
  urls,
  project,
}: {
  person: Person;
  urls: Record<string, string>;
  project: FamilyProject;
}) {
  return person.portraitId &&
    !isDeleted(project, 'media', person.portraitId) &&
    urls[person.portraitId] ? (
    <img
      className="profile-portrait"
      src={urls[person.portraitId]}
      alt={`Портрет: ${person.name}`}
    />
  ) : (
    <div className="profile-monogram" aria-hidden="true">
      {initials(person.name)}
    </div>
  );
}

export type PersonField = Exclude<keyof Person, 'id' | 'portraitId'>;
export type FieldDraft = { value: string; error: string };
