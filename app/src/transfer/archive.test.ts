import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { FamilyProject, ProjectSnapshot } from '../domain/types';
import { exportArchive, importArchive } from './archive';
import { moveToTrash } from '../domain/model';
import { buildArchiveLayout, calculateCapacity, CAPACITY_LIMITS } from '../domain/capacity';

function fixture(): ProjectSnapshot {
  const original = new Blob(['original-photo'], { type: 'image/jpeg' });
  const thumbnail = new Blob(['small-photo'], { type: 'image/webp' });
  const document = new Blob(['%PDF-test'], { type: 'application/pdf' });
  return {
    project: {
      id: 'project-1',
      title: 'Семья Ивановых',
      revision: 7,
      trash: [],
      createdAt: '2026-11-15T12:00:00.000Z',
      updatedAt: '2026-11-15T12:01:00.000Z',
      people: [
        {
          id: 'p1',
          name: 'Иван',
          birthDate: '~1900',
          deathDate: '1980',
          birthPlace: 'Старое название',
          lifeStatus: 'deceased',
          biography: 'История семьи',
          source: 'Со слов бабушки',
          portraitId: 'm1',
        },
        {
          id: 'p2',
          name: 'Анна',
          birthDate: '1930-02',
          deathDate: '',
          birthPlace: '',
          lifeStatus: 'unknown',
          biography: '',
          source: '',
        },
      ],
      relationships: [{ id: 'r1', fromId: 'p1', toId: 'p2', kind: 'biological' }],
      stories: [{ id: 's1', title: 'Воспоминание', text: 'Семейный рассказ', peopleIds: ['p1'] }],
      media: [
        {
          id: 'm1',
          name: 'original.jpg',
          mime: 'image/jpeg',
          size: original.size,
          caption: 'Портрет',
          peopleIds: ['p1'],
        },
        {
          id: 'm2',
          name: 'certificate.pdf',
          mime: 'application/pdf',
          size: document.size,
          caption: 'Свидетельство',
          peopleIds: ['p1', 'p2'],
        },
      ],
    },
    files: [
      { id: 'm1', projectId: 'project-1', original, thumbnail },
      { id: 'm2', projectId: 'project-1', original: document },
    ],
  };
}

function blob(bytes: Uint8Array): Blob {
  return new Blob([new Uint8Array(bytes).buffer], { type: 'application/zip' });
}

async function unpack(): Promise<Record<string, Uint8Array>> {
  return unzipSync(new Uint8Array(await (await exportArchive(fixture())).arrayBuffer()));
}

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function changeProject(change: (project: FamilyProject) => void): Promise<Blob> {
  const contents = await unpack();
  const project = JSON.parse(strFromU8(contents['project.json'])) as FamilyProject;
  change(project);
  contents['project.json'] = strToU8(JSON.stringify(project));
  const manifest = JSON.parse(strFromU8(contents['manifest.json']));
  const entry = manifest.entries.find((item: { path: string }) => item.path === 'project.json');
  entry.size = contents['project.json'].length;
  entry.sha256 = await digest(contents['project.json']);
  contents['manifest.json'] = strToU8(JSON.stringify(manifest));
  return blob(zipSync(contents, { level: 0 }));
}

async function legacyArchive(change?: (project: Record<string, unknown>) => void): Promise<Blob> {
  const contents = await unpack();
  const project = JSON.parse(strFromU8(contents['project.json']));
  delete project.trash;
  change?.(project);
  contents['project.json'] = strToU8(JSON.stringify(project));
  const manifest = JSON.parse(strFromU8(contents['manifest.json']));
  manifest.version = 1;
  const entry = manifest.entries.find((item: { path: string }) => item.path === 'project.json');
  entry.size = contents['project.json'].length;
  entry.sha256 = await digest(contents['project.json']);
  contents['manifest.json'] = strToU8(JSON.stringify(manifest));
  return blob(zipSync(contents, { level: 0 }));
}

// Изменяем оба объявления размера, оставляя прежний сжатый поток.
function forgeSize(bytes: Uint8Array, size: number): Uint8Array {
  const changed = new Uint8Array(bytes);
  const view = new DataView(changed.buffer);
  for (let offset = 0; offset + 46 <= changed.length; offset++) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04034b50) view.setUint32(offset + 22, size, true);
    if (signature === 0x02014b50) view.setUint32(offset + 24, size, true);
  }
  return changed;
}

describe('Полная резервная копия', () => {
  it('восстанавливает сведения, происхождение, оригиналы и уменьшенные фото без изменения байтов', async () => {
    const source = fixture();
    source.project.restoredFrom = { projectId: 'previous', createdAt: source.project.createdAt };
    const archive = await exportArchive(source);
    const restored = await importArchive(archive);
    expect(restored.project).toEqual(source.project);
    expect(restored.files).toHaveLength(2);
    for (let index = 0; index < source.files.length; index++) {
      expect(restored.files[index].id).toBe(source.files[index].id);
      expect(restored.files[index].projectId).toBe(source.project.id);
      expect(restored.files[index].original.type).toBe(source.files[index].original.type);
      expect(await restored.files[index].original.arrayBuffer()).toEqual(
        await source.files[index].original.arrayBuffer(),
      );
    }
    expect(await restored.files[0].thumbnail!.text()).toBe('small-photo');
    expect(restored.files[0].thumbnail!.type).toBe('image/webp');
    const contents = unzipSync(new Uint8Array(await archive.arrayBuffer()));
    expect(Object.keys(contents)).toEqual(
      expect.arrayContaining([
        'manifest.json',
        'project.json',
        'files/0001-original',
        'files/0001-thumbnail',
      ]),
    );
    expect(Object.keys(contents).join(' ')).not.toContain('original.jpg');
  });

  it('читает также сжатые архивы своего формата', async () => {
    const contents = await unpack();
    const restored = await importArchive(blob(zipSync(contents, { level: 6 })));
    expect(restored.project.people[0].birthDate).toBe('~1900');
    const repeated = await importArchive(await exportArchive(restored));
    expect(repeated.project).toEqual(restored.project);
    expect(await repeated.files[0].original.arrayBuffer()).toEqual(
      await restored.files[0].original.arrayBuffer(),
    );
  });

  it('отклоняет сжатую копию, которую нельзя повторно экспортировать в пределах 120 МиБ', async () => {
    const project = fixture().project;
    delete project.people[0].portraitId;
    project.media = [];
    const data = new Uint8Array(25 * 1024 * 1024);
    const hash = await digest(data);
    const contents: Record<string, Uint8Array> = {};
    const entries: { path: string; size: number; sha256: string }[] = [];
    const files: { id: string; originalPath: string; originalType: string }[] = [];
    for (let index = 1; index <= 5; index++) {
      const id = `large-${index}`;
      const path = `files/${String(index).padStart(4, '0')}-original`;
      contents[path] = data;
      entries.push({ path, size: data.length, sha256: hash });
      files.push({ id, originalPath: path, originalType: 'application/pdf' });
      project.media.push({
        id,
        name: `${index}.pdf`,
        mime: 'application/pdf',
        size: data.length,
        caption: '',
        peopleIds: ['p1'],
      });
    }
    const { trash: omittedTrash, ...legacy } = project;
    expect(omittedTrash).toEqual([]);
    const projectBytes = strToU8(JSON.stringify(legacy));
    contents['project.json'] = projectBytes;
    entries.unshift({
      path: 'project.json',
      size: projectBytes.length,
      sha256: await digest(projectBytes),
    });
    contents['manifest.json'] = strToU8(
      JSON.stringify({ format: 'rodoslovnaya', version: 1, entries, files }),
    );
    const compressed = zipSync(contents, { level: 6 });
    expect(compressed.length).toBeLessThan(1024 * 1024);
    expect(entries.reduce((sum, entry) => sum + entry.size, 0)).toBeLessThan(150 * 1024 * 1024);
    await expect(importArchive(blob(compressed))).rejects.toThrow(/повторно сохранить.*120 МиБ/);
  }, 20_000);

  it('отказывает при неизвестной версии', async () => {
    const contents = await unpack();
    const manifest = JSON.parse(strFromU8(contents['manifest.json']));
    manifest.version = 99;
    contents['manifest.json'] = strToU8(JSON.stringify(manifest));
    await expect(importArchive(blob(zipSync(contents)))).rejects.toThrow(/Версия/);
  });

  it('выдает формат v2 и включает корзину, исходные связи и удаленные оригиналы', async () => {
    const snapshot = fixture();
    snapshot.project = moveToTrash(snapshot.project, 'person', 'p1');
    snapshot.project = moveToTrash(snapshot.project, 'media', 'm1');
    const archive = await exportArchive(snapshot);
    const contents = unzipSync(new Uint8Array(await archive.arrayBuffer()));
    expect(JSON.parse(strFromU8(contents['manifest.json'])).version).toBe(2);
    const restored = await importArchive(archive);
    expect(restored.project).toEqual(snapshot.project);
    expect(await restored.files[0].original.text()).toBe('original-photo');
    expect(restored.project.trash).toHaveLength(2);
  });

  it('проверяет исходный v1 и только затем добавляет пустую корзину', async () => {
    const restored = await importArchive(await legacyArchive());
    expect(restored.project).toEqual(fixture().project);
    expect(restored.project.trash).toEqual([]);
    expect(calculateCapacity(restored.project, restored.files).ok).toBe(true);
    await expect(
      importArchive(
        await legacyArchive((project) => {
          project.trash = [];
        }),
      ),
    ).rejects.toThrow(/неизвестное поле/);
    await expect(
      importArchive(
        await legacyArchive((project) => {
          project.backupStatus = {};
        }),
      ),
    ).rejects.toThrow(/неизвестное поле/);
  });

  it('сохраняет восстанавливаемость пограничной v1 при служебном росте версии', async () => {
    const project = fixture().project;
    project.media = [];
    delete project.people[0].portraitId;
    const { trash: omittedTrash, ...legacy } = project;
    expect(omittedTrash).toEqual([]);
    const initialSize = new TextEncoder().encode(JSON.stringify(legacy)).length;
    legacy.people[0].biography += 'x'.repeat(CAPACITY_LIMITS.maxEntryBytes - initialSize);
    const { projectBytes, manifest, report } = buildArchiveLayout(legacy, [], 1);
    expect(projectBytes.length).toBe(CAPACITY_LIMITS.maxEntryBytes);
    expect(report.ok).toBe(true);
    manifest.entries[0].sha256 = await digest(projectBytes);
    const archive = blob(
      zipSync(
        {
          'project.json': projectBytes,
          'manifest.json': strToU8(JSON.stringify(manifest)),
        },
        { level: 0 },
      ),
    );
    const restored = await importArchive(archive);
    expect(restored.project.people[0].biography).toBe(legacy.people[0].biography);
    expect(restored.project.trash).toEqual([]);
    expect(calculateCapacity(restored.project, []).violations).toContain('maxEntryBytes');
    await expect(exportArchive(restored)).rejects.toThrow(/25 МиБ/);
  }, 20_000);

  it('не принимает скрытые поля манифеста и описания файла', async () => {
    for (const scope of ['manifest', 'entry', 'file']) {
      const contents = await unpack();
      const manifest = JSON.parse(strFromU8(contents['manifest.json']));
      const target =
        scope === 'manifest'
          ? manifest
          : scope === 'entry'
            ? manifest.entries[0]
            : manifest.files[0];
      target.extra = 'hidden';
      contents['manifest.json'] = strToU8(JSON.stringify(manifest));
      await expect(importArchive(blob(zipSync(contents, { level: 0 })))).rejects.toThrow();
    }
  });

  it('сообщает этапы обработки и прекращается по запросу до выдачи результата', async () => {
    const stages: string[] = [];
    const archive = await exportArchive(fixture(), {
      onProgress: (value) => stages.push(value.stage),
    });
    expect(stages[0]).toBe('checking');
    expect(stages).toContain('hashing');
    expect(stages).toContain('packing');
    expect(stages.at(-1)).toBe('complete');
    const controller = new AbortController();
    await expect(
      importArchive(archive, {
        signal: controller.signal,
        onProgress: (value) => {
          if (value.stage === 'hashing') controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await expect(exportArchive(fixture(), { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('не принимает отсутствующий оригинал', async () => {
    const contents = await unpack();
    delete contents['files/0001-original'];
    await expect(importArchive(blob(zipSync(contents)))).rejects.toThrow(/отсутствует/);
  });

  it('не принимает лишний файл', async () => {
    const contents = await unpack();
    contents['files/0999-original'] = strToU8('extra');
    await expect(importArchive(blob(zipSync(contents)))).rejects.toThrow(/лишние/);
  });

  it('проверяет SHA-256, даже когда ZIP после изменения пересобран с правильным CRC', async () => {
    const contents = await unpack();
    contents['files/0001-original'][0] ^= 1;
    await expect(importArchive(blob(zipSync(contents)))).rejects.toThrow(/SHA-256/);
  });

  it('отклоняет ссылки на отсутствующих людей', async () => {
    const archive = await changeProject((project) => {
      project.relationships[0].toId = 'missing';
    });
    await expect(importArchive(archive)).rejects.toThrow(/не найден/);
  });

  it('отклоняет цикл происхождения в архиве с правильными суммами', async () => {
    const archive = await changeProject((project) => {
      project.relationships.push({ id: 'r2', fromId: 'p2', toId: 'p1', kind: 'adoptive' });
    });
    await expect(importArchive(archive)).rejects.toThrow(/цикл/);
  });

  it('отклоняет материал без файла и неправильный размер оригинала', async () => {
    const missing = fixture();
    missing.files.pop();
    await expect(exportArchive(missing)).rejects.toThrow(/Число файлов/);
    const wrongSize = fixture();
    wrongSize.project.media[0].size++;
    await expect(exportArchive(wrongSize)).rejects.toThrow(/Размер/);
  });

  it('отклоняет опасный путь до распаковки', async () => {
    const archive = zipSync({ '../escape': strToU8('danger') });
    await expect(importArchive(blob(archive))).rejects.toThrow(/путь/);
  });

  it('не теряет дублирующиеся имена в каталоге', async () => {
    const bytes = zipSync(
      { 'files/0001-original': strToU8('a'), 'files/0002-original': strToU8('b') },
      { level: 0 },
    );
    const previous = strToU8('files/0002-original');
    const replacement = strToU8('files/0001-original');
    for (let offset = 0; offset <= bytes.length - previous.length; offset++) {
      if (previous.every((byte, index) => bytes[offset + index] === byte))
        bytes.set(replacement, offset);
    }
    await expect(importArchive(blob(bytes))).rejects.toThrow(/повторяется имя/);
  });

  it('отклоняет слишком большое объявленное распакованное содержимое до выделения памяти', async () => {
    const bytes = zipSync({ 'manifest.json': strToU8('{}') });
    await expect(importArchive(blob(forgeSize(bytes, 25 * 1024 * 1024 + 1)))).rejects.toThrow(
      /25 МиБ/,
    );
  });

  it('останавливает распаковку, если реальный поток больше ложного размера из заголовков', async () => {
    const compressed = zipSync({ 'manifest.json': new Uint8Array(200_000).fill(65) }, { level: 9 });
    await expect(importArchive(blob(forgeSize(compressed, 1)))).rejects.toThrow(
      /Фактический размер/,
    );
  });

  it('отклоняет суммарный распакованный размер больше 150 МиБ', async () => {
    const contents: Record<string, Uint8Array> = {};
    for (let index = 1; index <= 7; index++)
      contents[`files/${String(index).padStart(4, '0')}-original`] = strToU8('a');
    const bytes = forgeSize(zipSync(contents, { level: 6 }), 25 * 1024 * 1024);
    await expect(importArchive(blob(bytes))).rejects.toThrow(/150 МиБ/);
  });

  it('отклоняет более 500 файлов до распаковки', async () => {
    const contents: Record<string, Uint8Array> = {};
    for (let index = 1; index <= 501; index++)
      contents[`files/${String(index).padStart(4, '0')}-original`] = strToU8('a');
    await expect(importArchive(blob(zipSync(contents)))).rejects.toThrow(/500 файлов/);
  });

  it('отклоняет обрезанный или поврежденный ZIP без изменения переданного проекта', async () => {
    const source = fixture();
    const before = structuredClone(source.project);
    const archive = new Uint8Array(await (await exportArchive(source)).arrayBuffer());
    await expect(importArchive(blob(archive.subarray(0, archive.length - 10)))).rejects.toThrow();
    archive[50] ^= 1;
    await expect(importArchive(blob(archive))).rejects.toThrow();
    expect(source.project).toEqual(before);
  });
});
