import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { newProject } from './model';
import {
  assertCapacity,
  buildArchiveLayout,
  calculateCapacity,
  canReduceCapacity,
  CAPACITY_LIMITS,
  type ArchiveFileMetadata,
  type CapacityReport,
} from './capacity';

const file = (id: string, size: number, thumbnailSize?: number): ArchiveFileMetadata => ({
  id,
  original: { size, type: 'image/jpeg' },
  ...(thumbnailSize === undefined
    ? {}
    : { thumbnail: { size: thumbnailSize, type: 'image/webp' } }),
});

describe('Вместимость полной копии', () => {
  it('совпадает с размером настоящего ZIP STORE, включая UTF-8 и миниатюры', () => {
    const project = newProject('Семья Ёлкиных');
    const files = [file('фотография', 5, 3)];
    const { projectBytes, manifest, report } = buildArchiveLayout(project, files);
    const contents = {
      'project.json': projectBytes,
      'manifest.json': new TextEncoder().encode(JSON.stringify(manifest)),
      'files/0001-original': new Uint8Array(5),
      'files/0001-thumbnail': new Uint8Array(3),
    };
    const archive = zipSync(contents, { level: 0 });
    expect(report.ok).toBe(true);
    expect(report.storedBytes).toBe(archive.byteLength);
    expect(report.expandedBytes).toBe(
      Object.values(contents).reduce((sum, entry) => sum + entry.byteLength, 0),
    );
    expect(report.entries).toBe(4);
  });

  it('считает предел одного файла включительно и отклоняет следующий байт', () => {
    const project = newProject('Архив');
    expect(calculateCapacity(project, [file('m', CAPACITY_LIMITS.maxEntryBytes)]).ok).toBe(true);
    const tooLarge = calculateCapacity(project, [file('m', CAPACITY_LIMITS.maxEntryBytes + 1)]);
    expect(tooLarge.violations).toContain('maxEntryBytes');
    expect(() => assertCapacity(project, [file('m', CAPACITY_LIMITS.maxEntryBytes + 1)])).toThrow(
      /25 МиБ/,
    );
  });

  it('учитывает описания и миниатюры в 500 элементах', () => {
    const project = newProject('Архив');
    const files = Array.from({ length: 249 }, (_, index) => file(`m${index}`, 1, 1));
    expect(calculateCapacity(project, files).entries).toBe(500);
    expect(calculateCapacity(project, files).ok).toBe(true);
    expect(calculateCapacity(project, [...files, file('extra', 1)]).violations).toEqual([
      'entries',
    ]);
  });

  it('не требует выделения памяти для оценки больших оригиналов', () => {
    const project = newProject('Архив');
    const files = Array.from({ length: 5 }, (_, index) =>
      file(`m${index}`, CAPACITY_LIMITS.maxEntryBytes),
    );
    const report = calculateCapacity(project, files);
    expect(report.violations).toEqual(['storedBytes']);
    expect(report.expandedBytes).toBeLessThan(CAPACITY_LIMITS.expandedBytes);
  });

  it('различает точную границу 120 МиБ и следующий байт с учетом упаковки', () => {
    const project = newProject('Архив');
    const files = Array.from({ length: 4 }, (_, index) =>
      file(`m${index}`, CAPACITY_LIMITS.maxEntryBytes),
    );
    files.push(file('last', 20 * 1024 * 1024));
    const initial = calculateCapacity(project, files);
    const exactOriginalSize =
      files[4].original.size - (initial.storedBytes - CAPACITY_LIMITS.storedBytes);
    files[4] = file('last', exactOriginalSize);
    const exact = calculateCapacity(project, files);
    expect(exact.storedBytes).toBe(CAPACITY_LIMITS.storedBytes);
    expect(exact.ok).toBe(true);
    files[4] = file('last', exactOriginalSize + 1);
    expect(calculateCapacity(project, files).violations).toEqual(['storedBytes']);
  });

  it('учитывает размер сериализованного текста, корзину и конечную ревизию', () => {
    const project = newProject('Архив');
    const initial = calculateCapacity(project, []);
    project.revision = 10;
    project.trash = [
      { id: 'g', kind: 'person', entityId: 'p', deletedAt: project.updatedAt, relationshipIds: [] },
    ];
    const changed = calculateCapacity(project, []);
    expect(changed.projectBytes).toBeGreaterThan(initial.projectBytes);
    expect(changed.projectBytes).toBe(new TextEncoder().encode(JSON.stringify(project)).length);
    const { trash: omitted, ...legacy } = project;
    expect(omitted).toHaveLength(1);
    expect(calculateCapacity(legacy, [], 1).storedBytes).toBeLessThan(changed.storedBytes);
  });

  it('находит превышенный JSON как отдельный элемент, даже без фотографий', () => {
    const project = newProject('я'.repeat(13 * 1024 * 1024));
    const report = calculateCapacity(project, []);
    expect(report.violations).toContain('maxEntryBytes');
    expect(report.projectBytes).toBeGreaterThan(CAPACITY_LIMITS.maxEntryBytes);
  });

  it('разрешает только уменьшение нарушенного предела без ухудшения других', () => {
    const before: CapacityReport = {
      ok: false,
      violations: ['storedBytes'],
      projectBytes: 1000,
      maxEntryBytes: 1000,
      storedBytes: CAPACITY_LIMITS.storedBytes + 100,
      expandedBytes: 100_000,
      entries: 3,
    };
    expect(canReduceCapacity(before, { ...before, storedBytes: before.storedBytes - 1 })).toBe(
      true,
    );
    expect(canReduceCapacity(before, { ...before })).toBe(false);
    expect(
      canReduceCapacity(before, { ...before, storedBytes: before.storedBytes - 1, entries: 4 }),
    ).toBe(false);
    expect(
      canReduceCapacity(before, {
        ...before,
        storedBytes: before.storedBytes - 1,
        maxEntryBytes: CAPACITY_LIMITS.maxEntryBytes + 1,
        violations: ['storedBytes', 'maxEntryBytes'],
      }),
    ).toBe(false);
  });
});
