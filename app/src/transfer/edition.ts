import { getActiveRecords, validateProject } from '../domain/model';
import type { FamilyProject, ProjectSnapshot } from '../domain/types';
import { normalizeImage } from '../media';

const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface EditionOptions {
  mediaIds: string[];
  storyIds: string[];
  renderImage?: (blob: Blob) => Promise<Blob>;
}

export function getEditionCandidates(project: FamilyProject, selectedIds: string[]) {
  const active = getActiveRecords(project);
  const activeIds = new Set(active.people.map((person) => person.id));
  const selected = new Set(selectedIds.filter((id) => activeIds.has(id)));
  const safeMaterial = (ids: string[]) => ids.length > 0 && ids.every((id) => selected.has(id));
  return {
    media: active.media.filter(
      (material) => imageTypes.has(material.mime) && safeMaterial(material.peopleIds),
    ),
    stories: active.stories.filter((story) => safeMaterial(story.peopleIds)),
    excludedPdfCount: active.media.filter(
      (material) =>
        material.mime === 'application/pdf' && material.peopleIds.some((id) => selected.has(id)),
    ).length,
  };
}

function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!,
  );
}

async function imageData(blob: Blob): Promise<string> {
  if (!imageTypes.has(blob.type))
    throw new Error('Тип уменьшенного изображения не поддерживается.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16384) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

export async function createEdition(
  snapshot: ProjectSnapshot,
  selectedIds: string[],
  options: EditionOptions | ((blob: Blob) => Promise<Blob>) = { mediaIds: [], storyIds: [] },
): Promise<string> {
  const project = structuredClone(snapshot.project);
  const files = new Map(snapshot.files.map((file) => [file.id, { ...file }]));
  validateProject(project);
  const selected = new Set(selectedIds);
  if (!selected.size) throw new Error('Выберите хотя бы одного человека для выпуска.');
  const active = getActiveRecords(project);
  const allPeople = new Map(active.people.map((person) => [person.id, person]));
  if ([...selected].some((id) => !allPeople.has(id)))
    throw new Error('В состав выпуска включена неизвестная карточка.');
  const people = active.people.filter((person) => selected.has(person.id));
  const anchors = new Map(people.map((person, index) => [person.id, `person-${index + 1}`]));
  const candidates = getEditionCandidates(project, [...selected]);
  // Третий аргумент-функция сохранен для прежних проверок обработки изображений.
  // Пользовательский путь передает явные списки; без них материалы не выбираются.
  const choice =
    typeof options === 'function'
      ? {
          mediaIds: candidates.media.map((material) => material.id),
          storyIds: candidates.stories.map((story) => story.id),
          renderImage: options,
        }
      : { ...options, mediaIds: [...options.mediaIds], storyIds: [...options.storyIds] };
  const renderImage = choice.renderImage ?? normalizeImage;
  const selectedMedia = new Set(choice.mediaIds);
  const selectedStories = new Set(choice.storyIds);
  const materials = candidates.media.filter((material) => selectedMedia.has(material.id));
  const stories = candidates.stories.filter((story) => selectedStories.has(story.id));
  const images = new Map<string, string>();
  for (const material of materials) {
    const file = files.get(material.id);
    if (!file || file.projectId !== project.id) {
      throw new Error('У выбранной фотографии отсутствует сохраненный файл.');
    }
    // Импортированная миниатюра тоже недоверенна: в HTML идет только новая растровая копия.
    const rendered = await renderImage(file.thumbnail ?? file.original);
    images.set(material.id, await imageData(rendered));
  }
  const link = (id: string) =>
    `<a href="#${anchors.get(id)!}">${escape(allPeople.get(id)!.name)}</a>`;
  const cards = people
    .map((person) => {
      const portrait = person.portraitId && images.get(person.portraitId);
      return `<article id="${anchors.get(person.id)}"><h2>${escape(person.name)}</h2>
      ${portrait ? `<img class="portrait" src="${portrait}" alt="Портрет: ${escape(person.name)}">` : ''}
      ${person.birthDate ? `<p>Рождение: ${escape(person.birthDate)}</p>` : ''}
      ${person.birthPlace ? `<p>Место рождения: ${escape(person.birthPlace)}</p>` : ''}
      ${person.deathDate ? `<p>Смерть: ${escape(person.deathDate)}</p>` : ''}
      ${person.biography ? `<p class="text">${escape(person.biography)}</p>` : ''}
      ${person.source ? `<p class="text">Источник: ${escape(person.source)}</p>` : ''}
    </article>`;
    })
    .join('\n');
  const relationships = active.relationships
    .filter((relation) => selected.has(relation.fromId) && selected.has(relation.toId))
    .map(
      (relation) =>
        `<li>${link(relation.fromId)} ${
          relation.kind === 'partner'
            ? relation.status === 'separated'
              ? 'и бывший партнер'
              : 'и партнер'
            : relation.kind === 'adoptive'
              ? '- приемный родитель для'
              : '- родитель для'
        } ${link(relation.toId)}</li>`,
    )
    .join('\n');
  const gallery = materials
    .map((material, index) => {
      const image = images.get(material.id);
      return `<figure><img src="${image}" alt="Семейная фотография ${index + 1}">
      ${material.caption ? `<figcaption>${escape(material.caption)}</figcaption>` : ''}
      <p>Связанные люди: ${material.peopleIds.map(link).join(', ')}</p></figure>`;
    })
    .join('\n');
  const chapters = stories
    .map(
      (story) => `<section><h2>${escape(story.title)}</h2><p class="text">${escape(story.text)}</p>
    <p>Участники: ${story.peopleIds.map(link).join(', ')}</p></section>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer"><title>Семейная история</title>
<style>body{font-family:Georgia,serif;max-width:900px;margin:auto;padding:24px;color:#252a25;background:#fffdf7;line-height:1.6}a{color:#315d49}nav ul{columns:2}article,figure,section{margin:24px 0;padding:16px 0;border-top:1px solid #d7d9cf}img{max-width:100%;max-height:560px;height:auto}img.portrait{max-width:180px;max-height:220px}.text{white-space:pre-wrap;overflow-wrap:anywhere}h1,h2{line-height:1.25}figcaption{white-space:pre-wrap}@media print{body{padding:0;background:white;color:black}nav{display:none}article,figure{break-inside:avoid}a{color:inherit;text-decoration:none}}</style></head>
<body><header><h1>Семейная история</h1><p>Выбранные страницы семейного архива.</p></header>
<nav aria-label="Люди"><ul>${people.map((person) => `<li>${link(person.id)}</li>`).join('')}</ul></nav>
<main>${cards}${relationships ? `<section><h2>Родственные связи</h2><ul>${relationships}</ul></section>` : ''}
${gallery ? `<section><h2>Семейные материалы</h2>${gallery}</section>` : ''}${chapters}</main></body></html>`;
}
