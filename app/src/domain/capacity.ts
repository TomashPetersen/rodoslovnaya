import type { FamilyProject, LegacyFamilyProject, StoredFile } from './types';

const MIB = 1024 * 1024;
const encoder = new TextEncoder();

export const CAPACITY_LIMITS = {
  maxEntryBytes: 25 * MIB,
  storedBytes: 120 * MIB,
  expandedBytes: 150 * MIB,
  entries: 500,
} as const;

export type CapacityLimit = keyof typeof CAPACITY_LIMITS;
export interface CapacityReport {
  ok: boolean;
  violations: CapacityLimit[];
  projectBytes: number;
  maxEntryBytes: number;
  storedBytes: number;
  expandedBytes: number;
  entries: number;
}

export type ArchiveFileMetadata = Pick<StoredFile, 'id'> & {
  original: Pick<Blob, 'size' | 'type'>;
  thumbnail?: Pick<Blob, 'size' | 'type'>;
};
export interface ArchiveFileDescription {
  path: string;
  size: number;
  sha256: string;
}
export interface ArchiveFileMapping {
  id: string;
  originalPath: string;
  originalType: string;
  thumbnailPath?: string;
  thumbnailType?: string;
}
export interface ArchiveManifest {
  format: 'rodoslovnaya';
  version: 1 | 2;
  entries: ArchiveFileDescription[];
  files: ArchiveFileMapping[];
}

/** Расчет не читает Blob и не отбрасывает корзину или превышающие пределы данные. */
export function buildArchiveLayout(
  project: FamilyProject | LegacyFamilyProject,
  files: ArchiveFileMetadata[],
  version: 1 | 2 = 2,
) {
  const projectBytes = encoder.encode(JSON.stringify(project));
  const manifest: ArchiveManifest = { format: 'rodoslovnaya', version, entries: [], files: [] };
  const describe = (path: string, size: number) => {
    manifest.entries.push({ path, size, sha256: '0'.repeat(64) });
  };
  describe('project.json', projectBytes.length);
  files.forEach((file, index) => {
    const base = `files/${String(index + 1).padStart(4, '0')}`;
    const mapping: ArchiveFileMapping = {
      id: file.id,
      originalPath: `${base}-original`,
      originalType: file.original.type,
    };
    describe(mapping.originalPath, file.original.size);
    if (file.thumbnail) {
      mapping.thumbnailPath = `${base}-thumbnail`;
      mapping.thumbnailType = file.thumbnail.type;
      describe(mapping.thumbnailPath, file.thumbnail.size);
    }
    manifest.files.push(mapping);
  });
  const manifestSize = encoder.encode(JSON.stringify(manifest)).length;
  const payload = [...manifest.entries, { path: 'manifest.json', size: manifestSize }];
  const expandedBytes = payload.reduce((sum, entry) => sum + entry.size, 0);
  // ZIP STORE без комментариев и дополнительных полей: 30 + 46 байт на запись,
  // два имени UTF-8 и 22 байта завершающего каталога.
  const storedBytes = payload.reduce(
    (sum, entry) => sum + entry.size + 76 + 2 * encoder.encode(entry.path).length,
    22,
  );
  const measurements = {
    projectBytes: projectBytes.length,
    maxEntryBytes: payload.reduce((maximum, entry) => Math.max(maximum, entry.size), 0),
    storedBytes,
    expandedBytes,
    entries: payload.length,
  };
  const violations = (Object.keys(CAPACITY_LIMITS) as CapacityLimit[]).filter(
    (key) => !Number.isSafeInteger(measurements[key]) || measurements[key] > CAPACITY_LIMITS[key],
  );
  const report: CapacityReport = { ...measurements, violations, ok: violations.length === 0 };
  return { projectBytes, manifest, report };
}

export function calculateCapacity(
  project: FamilyProject | LegacyFamilyProject,
  files: ArchiveFileMetadata[],
  version: 1 | 2 = 2,
): CapacityReport {
  return buildArchiveLayout(project, files, version).report;
}

export const CAPACITY_MESSAGES: Record<CapacityLimit, string> = {
  maxEntryBytes: 'Один элемент полной копии превышает ограничение 25 МиБ.',
  storedBytes: 'Эти данные нельзя повторно сохранить: полная копия превысит ограничение 120 МиБ.',
  expandedBytes: 'Распакованные данные превышают ограничение 150 МиБ.',
  entries: 'В полной копии больше 500 элементов, включая описания и миниатюры.',
};

export class CapacityError extends Error {
  constructor(public readonly report: CapacityReport) {
    super(report.violations.map((key) => CAPACITY_MESSAGES[key]).join(' '));
    this.name = 'CapacityError';
  }
}

export function assertCapacity(
  project: FamilyProject | LegacyFamilyProject,
  files: ArchiveFileMetadata[],
  version: 1 | 2 = 2,
): CapacityReport {
  const report = calculateCapacity(project, files, version);
  if (!report.ok) throw new CapacityError(report);
  return report;
}

/** Обычная правка переполненного архива должна улучшать предел без ухудшения других. */
export function canReduceCapacity(before: CapacityReport, after: CapacityReport): boolean {
  if (before.ok) return after.ok;
  return (
    (Object.keys(CAPACITY_LIMITS) as CapacityLimit[]).every((key) => after[key] <= before[key]) &&
    before.violations.some((key) => after[key] < before[key]) &&
    after.violations.every((key) => before.violations.includes(key))
  );
}
