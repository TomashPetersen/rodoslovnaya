import { describe, expect, it } from 'vitest';
import type { Media, ProjectSnapshot } from '../domain/types';
import { createEdition as createRenderedEdition, getEditionCandidates } from './edition';
import { moveToTrash } from '../domain/model';

// Здесь проверяем сборку документа. Реальное перекодирование canvas проверяется в браузере.
const createEdition = (snapshot: ProjectSnapshot, ids: string[]) =>
  createRenderedEdition(snapshot, ids, async (image) => image);

function fixture(): ProjectSnapshot {
  const original = new Blob(['SECRET_ORIGINAL_BYTES'], { type: 'image/jpeg' });
  const thumbnail = new Blob(['SAFE_THUMBNAIL'], { type: 'image/webp' });
  const media: Media = {
    id: 'm1',
    name: 'PRIVATE_ORIGINAL_NAME.jpg',
    mime: 'image/jpeg',
    size: original.size,
    caption: 'Семейное фото',
    peopleIds: ['p1'],
  };
  return {
    project: {
      id: 'PRIVATE_PROJECT_ID',
      title: 'PRIVATE_PROJECT_TITLE',
      revision: 1,
      trash: [],
      createdAt: '2026-11-15T00:00:00.000Z',
      updatedAt: '2026-11-15T00:00:00.000Z',
      people: [
        {
          id: 'p1',
          name: 'Иван',
          birthDate: '~1900',
          deathDate: '1980',
          birthPlace: 'Село',
          lifeStatus: 'deceased',
          biography: 'Жил в селе',
          source: 'Со слов бабушки',
          portraitId: 'm1',
        },
        {
          id: 'p2',
          name: 'PRIVATE_PERSON',
          birthDate: '',
          deathDate: '',
          birthPlace: 'PRIVATE_PLACE',
          lifeStatus: 'alive',
          biography: 'PRIVATE_BIOGRAPHY',
          source: 'PRIVATE_SOURCE',
        },
      ],
      relationships: [{ id: 'PRIVATE_RELATION', fromId: 'p1', toId: 'p2', kind: 'biological' }],
      stories: [
        { id: 's1', title: 'Рассказ об Иване', text: 'Семейная история', peopleIds: ['p1'] },
        {
          id: 's2',
          title: 'PRIVATE_SHARED_STORY',
          text: 'PRIVATE_SHARED_TEXT',
          peopleIds: ['p1', 'p2'],
        },
        { id: 's3', title: 'PRIVATE_UNLINKED_STORY', text: 'PRIVATE_UNLINKED_TEXT', peopleIds: [] },
      ],
      media: [media],
    },
    files: [{ id: 'm1', projectId: 'PRIVATE_PROJECT_ID', original, thumbnail }],
  };
}

describe('Семейный выпуск', () => {
  it('считает исключенные PDF только среди материалов выбранных людей', () => {
    const { project } = fixture();
    project.people[0].name = 'Анна';
    project.people[1].name = 'Борис';
    project.media.push({
      id: 'boris-pdf',
      name: 'document.pdf',
      mime: 'application/pdf',
      size: 1,
      caption: 'Документ Бориса',
      peopleIds: ['p2'],
    });
    expect(getEditionCandidates(project, ['p1']).excludedPdfCount).toBe(0);
    expect(getEditionCandidates(project, ['p2']).excludedPdfCount).toBe(1);
    expect(getEditionCandidates(project, []).excludedPdfCount).toBe(0);
  });

  it('учитывает общий PDF по одному выбранному участнику, исключая корзину', () => {
    let { project } = fixture();
    project.media.push({
      id: 'shared-pdf',
      name: 'shared.pdf',
      mime: 'application/pdf',
      size: 1,
      caption: 'Общий документ',
      peopleIds: ['p1', 'p2'],
    });
    expect(getEditionCandidates(project, ['p1']).excludedPdfCount).toBe(1);
    expect(getEditionCandidates(project, ['p1', 'p2']).excludedPdfCount).toBe(1);
    project = moveToTrash(project, 'media', 'shared-pdf');
    expect(getEditionCandidates(project, ['p1', 'p2']).excludedPdfCount).toBe(0);
  });

  it('включает выбранные сведения и уменьшенное фото, исключая исходник и скрытые данные', async () => {
    const html = await createEdition(fixture(), ['p1']);
    expect(html).toContain('Иван');
    expect(html).toContain('Рассказ об Иване');
    expect(html).toContain('data:image/webp;base64,' + btoa('SAFE_THUMBNAIL'));
    expect(html).not.toContain(btoa('SECRET_ORIGINAL_BYTES'));
    expect(html).not.toContain('PRIVATE_');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('application/json');
    expect(html).not.toMatch(/(?:src|href)=["']https?:/);
    expect(html).toContain('@media print');
  });

  it('экранирует все пользовательские строки, включая имена, источник, подписи и рассказы', async () => {
    const snapshot = fixture();
    const payload = '<script>alert("x")</script><img src="https://example.invalid/private">&';
    snapshot.project.people[0].name = payload;
    snapshot.project.people[0].biography = payload;
    snapshot.project.people[0].source = payload;
    snapshot.project.people[0].birthPlace = payload;
    snapshot.project.media[0].caption = payload;
    snapshot.project.stories[0].title = payload;
    snapshot.project.stories[0].text = payload;
    const html = await createEdition(snapshot, ['p1']);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src="https:');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });

  it('исключает общее фото и портрет, если связанный человек не выбран', async () => {
    const snapshot = fixture();
    snapshot.project.media[0].peopleIds.push('p2');
    snapshot.project.media[0].caption = 'PRIVATE_SHARED_CAPTION';
    const html = await createEdition(snapshot, ['p1']);
    expect(html).not.toContain('PRIVATE_');
    expect(html).not.toContain('data:image/');
  });

  it('не включает материалы без установленных участников', async () => {
    const snapshot = fixture();
    snapshot.project.media[0].peopleIds = [];
    snapshot.project.media[0].caption = 'PRIVATE_UNLINKED_CAPTION';
    const html = await createEdition(snapshot, ['p1']);
    expect(html).not.toContain('PRIVATE_');
    expect(html).not.toContain('data:image/');
  });

  it('включает общие связи и рассказы только после выбора всех участников', async () => {
    const html = await createEdition(fixture(), ['p1', 'p2']);
    expect(html).toContain('PRIVATE_PERSON');
    expect(html).toContain('PRIVATE_SHARED_STORY');
    expect(html).toContain('родитель для');
    expect(html).not.toContain('PRIVATE_UNLINKED_STORY');
  });

  it('исключает PDF целиком, включая описание и подпись', async () => {
    const snapshot = fixture();
    delete snapshot.project.people[0].portraitId;
    snapshot.project.media[0].mime = 'application/pdf';
    snapshot.project.media[0].name = 'PRIVATE_NAME.pdf';
    snapshot.project.media[0].caption = 'PRIVATE_DOC_CAPTION';
    const html = await createEdition(snapshot, ['p1']);
    expect(html).not.toContain('Документ PDF');
    expect(html).not.toContain('PRIVATE_');
    expect(html).not.toContain('data:application/pdf');
  });

  it('без явного выбора не добавляет фотографии, портреты и рассказы', async () => {
    const html = await createRenderedEdition(fixture(), ['p1']);
    expect(html).toContain('Иван');
    expect(html).not.toContain('data:image/');
    expect(html).not.toContain('Рассказ об Иване');
    expect(html).not.toContain('Семейное фото');
  });

  it('собирает только явно выбранные подходящие материалы', async () => {
    const snapshot = fixture();
    const options = { mediaIds: ['m1'], storyIds: [], renderImage: async (image: Blob) => image };
    const html = await createRenderedEdition(snapshot, ['p1'], options);
    expect(html).toContain('data:image/webp;');
    expect(html).toContain('class="portrait"');
    expect(html).not.toContain('Рассказ об Иване');
    const onlyStory = await createRenderedEdition(snapshot, ['p1'], {
      ...options,
      mediaIds: [],
      storyIds: ['s1'],
    });
    expect(onlyStory).toContain('Рассказ об Иване');
    expect(onlyStory).not.toContain('data:image/');
  });

  it('корзина и связанные с ней участники не проходят даже при явном выборе', async () => {
    const snapshot = fixture();
    snapshot.project = moveToTrash(snapshot.project, 'media', 'm1');
    snapshot.project = moveToTrash(snapshot.project, 'story', 's1');
    const html = await createRenderedEdition(snapshot, ['p1'], {
      mediaIds: ['m1'],
      storyIds: ['s1', 's2'],
      renderImage: async (image) => image,
    });
    expect(html).not.toContain('data:image/');
    expect(html).not.toContain('Рассказ об Иване');
    expect(html).not.toContain('PRIVATE_');
    snapshot.project = moveToTrash(snapshot.project, 'person', 'p2');
    await expect(createRenderedEdition(snapshot, ['p2'])).rejects.toThrow(/неизвестная карточка/);
    expect(getEditionCandidates(snapshot.project, ['p1', 'p2']).stories).toEqual([]);
  });

  it('не меняет переданный выбор и фиксирует его до обработки изображения', async () => {
    const snapshot = fixture();
    const mediaIds = ['m1'];
    const storyIds = ['s1'];
    const pending = createRenderedEdition(snapshot, ['p1'], {
      mediaIds,
      storyIds,
      renderImage: async (image) => image,
    });
    mediaIds.length = 0;
    storyIds.length = 0;
    const html = await pending;
    expect(html).toContain('Семейное фото');
    expect(html).toContain('Рассказ об Иване');
  });

  it('отклоняет неизвестного человека, пустой состав и отсутствие файла фото', async () => {
    await expect(createEdition(fixture(), ['missing'])).rejects.toThrow(/неизвестная карточка/);
    await expect(createEdition(fixture(), [])).rejects.toThrow(/Выберите/);
    const snapshot = fixture();
    snapshot.files = [];
    await expect(createEdition(snapshot, ['p1'])).rejects.toThrow(/сохраненный файл/);
  });

  it('обязательно преобразует импортированную миниатюру и включает только результат преобразования', async () => {
    const snapshot = fixture();
    const untrusted = new Blob(['PHOTO_WITH_PRIVATE_EXIF_METADATA'], { type: 'image/png' });
    snapshot.files[0].thumbnail = untrusted;
    const rendered = new Blob(['CLEAN_PIXELS_ONLY'], { type: 'image/jpeg' });
    const received: Blob[] = [];
    const html = await createRenderedEdition(snapshot, ['p1'], async (input) => {
      received.push(input);
      return rendered;
    });
    expect(received).toEqual([untrusted]);
    expect(html).toContain('data:image/jpeg;base64,' + btoa('CLEAN_PIXELS_ONLY'));
    expect(html).not.toContain(btoa('PHOTO_WITH_PRIVATE_EXIF_METADATA'));
    expect(html).not.toContain(btoa('SECRET_ORIGINAL_BYTES'));
  });

  it('восстанавливает изображение из оригинала при отсутствии миниатюры, не вставляя исходные байты', async () => {
    const snapshot = fixture();
    delete snapshot.files[0].thumbnail;
    const received: Blob[] = [];
    const html = await createRenderedEdition(snapshot, ['p1'], async (input) => {
      received.push(input);
      return new Blob(['REGENERATED_IMAGE'], { type: 'image/jpeg' });
    });
    expect(received).toEqual([snapshot.files[0].original]);
    expect(html).toContain(btoa('REGENERATED_IMAGE'));
    expect(html).not.toContain(btoa('SECRET_ORIGINAL_BYTES'));
  });

  it('не принимает исполняемый формат уменьшенного изображения', async () => {
    const snapshot = fixture();
    snapshot.files[0].thumbnail = new Blob(['<svg><script>alert(1)</script></svg>'], {
      type: 'image/svg+xml',
    });
    await expect(createEdition(snapshot, ['p1'])).rejects.toThrow(/Тип/);
  });

  it('фиксирует содержимое до первой асинхронной операции', async () => {
    const snapshot = fixture();
    const pending = createEdition(snapshot, ['p1']);
    snapshot.project.people[0].name = 'PRIVATE_LATE_EDIT';
    snapshot.project.stories[0].text = 'PRIVATE_LATE_STORY';
    const html = await pending;
    expect(html).toContain('Иван');
    expect(html).not.toContain('PRIVATE_LATE');
  });
});
