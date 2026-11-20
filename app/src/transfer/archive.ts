import { Inflate, zip, type AsyncZippable } from 'fflate';
import { migrateLegacyProject, validateLegacyProject, validateProject } from '../domain/model';
import type {
  FamilyProject,
  LegacyFamilyProject,
  ProjectSnapshot,
  StoredFile,
} from '../domain/types';
import {
  assertCapacity,
  buildArchiveLayout,
  CAPACITY_LIMITS,
  CapacityError,
  type ArchiveFileDescription as FileDescription,
  type ArchiveFileMetadata as FileMetadata,
  type ArchiveManifest as Manifest,
} from '../domain/capacity';

const MAX_ARCHIVE = CAPACITY_LIMITS.storedBytes;
const MAX_EXPANDED = CAPACITY_LIMITS.expandedBytes;
const MAX_FILE = CAPACITY_LIMITS.maxEntryBytes;
const MAX_ENTRIES = CAPACITY_LIMITS.entries;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const allowedPath = /^(manifest\.json|project\.json|files\/\d{4}-(original|thumbnail))$/;

interface Entry {
  path: string;
  size: number;
  compressed: number;
  method: number;
  start: number;
  crc: number;
}

export interface ArchiveProgress {
  stage: 'checking' | 'reading' | 'hashing' | 'packing' | 'validating' | 'complete';
  completed?: number;
  total?: number;
}
export interface ArchiveTaskOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ArchiveProgress) => void;
}

function checkCancelled(options: ArchiveTaskOptions): void {
  if (options.signal?.aborted) throw new DOMException('Операция отменена.', 'AbortError');
}

function progress(options: ArchiveTaskOptions, value: ArchiveProgress): void {
  checkCancelled(options);
  options.onProgress?.(value);
}

function fail(message: string): never {
  throw new Error(message);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function computeArchiveChecksum(blob: Blob): Promise<string> {
  return sha256(new Uint8Array(await blob.arrayBuffer()));
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

// Каталог проверяется целиком до выделения памяти для распакованных файлов.
// Поддерживаемые форматы не используют ZIP64, шифрование и потоковые описатели размеров.
function inspectDirectory(bytes: Uint8Array): Entry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (start: number, count: number) => {
    if (start < 0 || start + count > bytes.length) fail('Архив обрезан или поврежден.');
  };
  const u16 = (offset: number) => {
    need(offset, 2);
    return view.getUint16(offset, true);
  };
  const u32 = (offset: number) => {
    need(offset, 4);
    return view.getUint32(offset, true);
  };
  let end = bytes.length - 22;
  const earliest = Math.max(0, bytes.length - 65557);
  for (; end >= earliest; end--) {
    if (u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === bytes.length) break;
  }
  if (end < earliest) fail('Не найден корректный каталог ZIP.');
  const count = u16(end + 10);
  const directorySize = u32(end + 12);
  const directoryStart = u32(end + 16);
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== count) {
    fail('Многотомные архивы не поддерживаются.');
  }
  if (!count || count > MAX_ENTRIES) fail('В архиве должно быть от 1 до 500 файлов.');
  if (directoryStart + directorySize !== end) fail('Структура каталога архива повреждена.');
  const paths = new Set<string>();
  const entries: Entry[] = [];
  const localRanges: { start: number; end: number }[] = [];
  let offset = directoryStart;
  let total = 0;
  for (let index = 0; index < count; index++) {
    need(offset, 46);
    if (u32(offset) !== 0x02014b50) fail('Повреждена запись каталога архива.');
    const flags = u16(offset + 8);
    const method = u16(offset + 10);
    const crc = u32(offset + 16);
    const compressed = u32(offset + 20);
    const size = u32(offset + 24);
    const nameSize = u16(offset + 28);
    const extraSize = u16(offset + 30);
    const commentSize = u16(offset + 32);
    const local = u32(offset + 42);
    need(offset + 46, nameSize + extraSize + commentSize);
    const path = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameSize));
    if (!allowedPath.test(path)) fail('В архиве найден недопустимый путь или имя файла.');
    if (paths.has(path)) fail('В архиве повторяется имя файла.');
    paths.add(path);
    if (flags & ~0x0806 || (method !== 0 && method !== 8) || u16(offset + 34)) {
      fail('Способ упаковки, шифрование или версия ZIP не поддерживаются.');
    }
    if (u16(offset + 6) > 20 || local === 0xffffffff || compressed === 0xffffffff) {
      fail('Расширенный формат ZIP64 не поддерживается.');
    }
    if (size > MAX_FILE || compressed > MAX_FILE + 65536) {
      fail('Один файл архива превышает ограничение 25 МиБ.');
    }
    total += size;
    if (total > MAX_EXPANDED) fail('Распакованный архив превышает ограничение 150 МиБ.');
    need(local, 30);
    if (u32(local) !== 0x04034b50) fail('Поврежден локальный заголовок файла.');
    const localNameSize = u16(local + 26);
    const localExtraSize = u16(local + 28);
    need(local + 30, localNameSize + localExtraSize);
    const localName = decoder.decode(bytes.subarray(local + 30, local + 30 + localNameSize));
    if (
      localName !== path ||
      u16(local + 6) !== flags ||
      u16(local + 8) !== method ||
      u32(local + 14) !== crc ||
      u32(local + 18) !== compressed ||
      u32(local + 22) !== size
    )
      fail('Каталог и локальный заголовок файла не совпадают.');
    const start = local + 30 + localNameSize + localExtraSize;
    need(start, compressed);
    if (start + compressed > directoryStart || (method === 0 && size !== compressed)) {
      fail('Размер или положение файла в архиве некорректны.');
    }
    localRanges.push({ start: local, end: start + compressed });
    entries.push({ path, size, compressed, method, start, crc });
    offset += 46 + nameSize + extraSize + commentSize;
    if (offset > end) fail('Каталог архива выходит за допустимые границы.');
  }
  if (offset !== end) fail('В каталоге архива обнаружены лишние данные.');
  localRanges.sort((a, b) => a.start - b.start);
  let expectedStart = 0;
  for (const range of localRanges) {
    if (range.start !== expectedStart)
      fail('Файлы архива пересекаются или содержат скрытые данные.');
    expectedStart = range.end;
  }
  if (expectedStart !== directoryStart) fail('Перед каталогом архива обнаружены лишние данные.');
  return entries;
}

async function expand(
  bytes: Uint8Array,
  entry: Entry,
  options: ArchiveTaskOptions = {},
): Promise<Uint8Array> {
  checkCancelled(options);
  let output: Uint8Array;
  if (entry.method === 0) {
    output = bytes.slice(entry.start, entry.start + entry.compressed);
  } else {
    const chunks: Uint8Array[] = [];
    let actual = 0;
    let finished = false;
    const inflater = new Inflate((chunk, final) => {
      actual += chunk.length;
      if (actual > entry.size || actual > MAX_FILE) {
        fail('Фактический размер распакованного файла превышает заявленный или допустимый.');
      }
      chunks.push(chunk);
      finished = final;
    });
    // Малые входные порции ограничивают разовое расширение даже при ложном размере в ZIP.
    // В отличие от полной распаковки, обработка прекращается сразу при превышении.
    for (let read = 0; read < entry.compressed; read += 1024) {
      checkCancelled(options);
      const end = Math.min(read + 1024, entry.compressed);
      inflater.push(
        bytes.subarray(entry.start + read, entry.start + end),
        end === entry.compressed,
      );
      if (read && read % 32768 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (!finished || actual !== entry.size)
      fail('Распакованный файл неполон или имеет неверный размер.');
    output = new Uint8Array(actual);
    let position = 0;
    for (const chunk of chunks) {
      output.set(chunk, position);
      position += chunk.length;
    }
  }
  if (output.length !== entry.size || crc32(output) !== entry.crc) {
    fail('Контрольная сумма ZIP не совпадает: файл поврежден.');
  }
  return output;
}

function parseManifest(value: unknown): Manifest {
  if (!record(value) || value.format !== 'rodoslovnaya')
    fail('Неизвестный формат резервной копии.');
  if (value.version !== 1 && value.version !== 2) fail('Версия резервной копии не поддерживается.');
  if (
    !Object.keys(value).every((key) => ['format', 'version', 'entries', 'files'].includes(key)) ||
    !Array.isArray(value.entries) ||
    !Array.isArray(value.files) ||
    value.entries.length > MAX_ENTRIES - 1 ||
    value.files.length > MAX_ENTRIES - 2
  ) {
    fail('Описание состава резервной копии некорректно.');
  }
  for (const entry of value.entries) {
    if (
      !record(entry) ||
      !Object.keys(entry).every((key) => ['path', 'size', 'sha256'].includes(key)) ||
      typeof entry.path !== 'string' ||
      !allowedPath.test(entry.path) ||
      entry.path === 'manifest.json' ||
      !Number.isSafeInteger(entry.size) ||
      (entry.size as number) < 0 ||
      (entry.size as number) > MAX_FILE ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      fail('Некорректная запись размера, пути или контрольной суммы файла.');
    }
  }
  for (const file of value.files) {
    if (
      !record(file) ||
      !Object.keys(file).every((key) =>
        ['id', 'originalPath', 'originalType', 'thumbnailPath', 'thumbnailType'].includes(key),
      ) ||
      typeof file.id !== 'string' ||
      !file.id ||
      typeof file.originalPath !== 'string' ||
      !/^files\/\d{4}-original$/.test(file.originalPath) ||
      typeof file.originalType !== 'string' ||
      (file.originalType !== '' &&
        !imageTypes.has(file.originalType) &&
        file.originalType !== 'application/pdf') ||
      (file.thumbnailPath !== undefined &&
        (typeof file.thumbnailPath !== 'string' ||
          !/^files\/\d{4}-thumbnail$/.test(file.thumbnailPath) ||
          typeof file.thumbnailType !== 'string' ||
          !imageTypes.has(file.thumbnailType))) ||
      (file.thumbnailPath === undefined && file.thumbnailType !== undefined)
    ) {
      fail('Описание оригинала или уменьшенного изображения некорректно.');
    }
  }
  return value as unknown as Manifest;
}

function validateFiles(project: FamilyProject, files: StoredFile[]): void {
  const media = new Map(project.media.map((item) => [item.id, item]));
  const seen = new Set<string>();
  if (files.length !== media.size) fail('Число файлов не соответствует материалам проекта.');
  for (const file of files) {
    const item = media.get(file.id);
    if (
      !item ||
      seen.has(file.id) ||
      file.projectId !== project.id ||
      !(file.original instanceof Blob)
    ) {
      fail('Файл не соответствует проекту или повторяется.');
    }
    seen.add(file.id);
    if (
      file.original.size !== item.size ||
      (file.original.type !== '' && file.original.type !== item.mime)
    ) {
      fail('Размер или тип оригинала не соответствует описанию материала.');
    }
    if (
      file.original.size > MAX_FILE ||
      (file.thumbnail &&
        (!(file.thumbnail instanceof Blob) ||
          file.thumbnail.size > MAX_FILE ||
          !imageTypes.has(file.thumbnail.type)))
    ) {
      fail('Размер или тип файла не поддерживается; предел одного файла - 25 МиБ.');
    }
  }
}

export async function exportArchive(
  snapshot: ProjectSnapshot,
  options: ArchiveTaskOptions = {},
): Promise<Blob> {
  progress(options, { stage: 'checking' });
  const project = structuredClone(snapshot.project);
  const files = snapshot.files.map((file) => ({ ...file }));
  validateProject(project);
  validateFiles(project, files);
  const { manifest, projectBytes, report } = buildArchiveLayout(project, files);
  if (!report.ok) throw new CapacityError(report);
  const descriptions = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  const contents: AsyncZippable = Object.create(null) as AsyncZippable;
  let completed = 0;
  const add = async (path: string, bytes: Uint8Array) => {
    progress(options, { stage: 'hashing', completed, total: manifest.entries.length });
    contents[path] = [bytes, { level: 0 }];
    descriptions.get(path)!.sha256 = await sha256(bytes);
    completed++;
  };
  await add('project.json', projectBytes);
  for (let index = 0; index < files.length; index++) {
    progress(options, { stage: 'reading', completed: index, total: files.length });
    const file = files[index];
    const mapping = manifest.files[index];
    await add(mapping.originalPath, new Uint8Array(await file.original.arrayBuffer()));
    if (file.thumbnail) {
      await add(mapping.thumbnailPath!, new Uint8Array(await file.thumbnail.arrayBuffer()));
    }
  }
  const description = encoder.encode(JSON.stringify(manifest));
  contents['manifest.json'] = [description, { level: 0 }];
  progress(options, { stage: 'packing' });
  checkCancelled(options);
  return new Promise<Blob>((resolve, reject) => {
    const onAbort = () => {
      cancelZip();
      reject(new DOMException('Операция отменена.', 'AbortError'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const cancelZip = zip(contents, { level: 0 }, (error, data) => {
      options.signal?.removeEventListener('abort', onAbort);
      if (options.signal?.aborted) {
        reject(new DOMException('Операция отменена.', 'AbortError'));
        return;
      }
      if (error) reject(new Error('Не удалось упаковать резервную копию.'));
      else if (data.length > MAX_ARCHIVE)
        reject(new Error('Резервная копия превышает ограничение 120 МиБ.'));
      else if (data.length !== report.storedBytes)
        reject(new Error('Размер созданной копии не совпал с предварительным расчетом.'));
      else {
        progress(options, { stage: 'complete' });
        resolve(new Blob([new Uint8Array(data).buffer], { type: 'application/zip' }));
      }
    });
  });
}

export async function importArchive(
  blob: Blob,
  options: ArchiveTaskOptions = {},
): Promise<ProjectSnapshot> {
  progress(options, { stage: 'checking' });
  if (!blob.size || blob.size > MAX_ARCHIVE)
    fail('Размер резервной копии должен быть не больше 120 МиБ.');
  try {
    progress(options, { stage: 'reading' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    checkCancelled(options);
    const entries = inspectDirectory(bytes);
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    const manifestEntry = byPath.get('manifest.json');
    if (!manifestEntry) fail('В архиве отсутствует описание формата.');
    const manifest = parseManifest(
      JSON.parse(decoder.decode(await expand(bytes, manifestEntry, options))),
    );
    const expected = new Set<string>(['manifest.json']);
    for (const item of manifest.entries) {
      if (expected.has(item.path)) fail('В описании архива повторяется путь файла.');
      expected.add(item.path);
      const actual = byPath.get(item.path);
      if (!actual || actual.size !== item.size)
        fail('Заявленный файл отсутствует или имеет неверный размер.');
    }
    if (expected.size !== entries.length || !expected.has('project.json')) {
      fail('В архиве отсутствуют обязательные файлы или присутствуют лишние.');
    }
    let completed = 0;
    const readEntry = async (item: FileDescription) => {
      progress(options, { stage: 'hashing', completed, total: manifest.entries.length });
      const data = await expand(bytes, byPath.get(item.path)!, options);
      if ((await sha256(data)) !== item.sha256)
        fail('Контрольная сумма SHA-256 не совпадает: копия повреждена.');
      completed++;
      return data;
    };
    const projectData = await readEntry(
      manifest.entries.find((entry) => entry.path === 'project.json')!,
    );
    const rawProject: unknown = JSON.parse(decoder.decode(projectData));
    let sourceProject: FamilyProject | LegacyFamilyProject;
    if (manifest.version === 1) {
      // Старый валидатор должен увидеть исходные поля, без заранее добавленной корзины.
      validateLegacyProject(rawProject);
      sourceProject = rawProject;
    } else {
      validateProject(rawProject);
      sourceProject = rawProject;
    }
    const metadata: FileMetadata[] = manifest.files.map((mapping) => {
      const sizeOf = (path: string) => {
        const entry = byPath.get(path);
        if (!entry) fail('Связь материала с файлом отсутствует.');
        return entry.size;
      };
      return {
        id: mapping.id,
        original: { size: sizeOf(mapping.originalPath), type: mapping.originalType },
        ...(mapping.thumbnailPath
          ? {
              thumbnail: {
                size: sizeOf(mapping.thumbnailPath),
                type: mapping.thumbnailType!,
              },
            }
          : {}),
      };
    });
    // Проверяем возможность повторной копии до распаковки больших оригиналов.
    assertCapacity(sourceProject, metadata, manifest.version);
    // Добавление пустой корзины может перевести строго пограничную v1 в защитный режим.
    // Исходная копия уже проверена в собственном формате; сведения не обрезаются.
    const project =
      manifest.version === 1
        ? migrateLegacyProject(sourceProject)
        : (sourceProject as FamilyProject);
    const expanded = new Map<string, Uint8Array>([['project.json', projectData]]);
    for (const item of manifest.entries) {
      if (item.path !== 'project.json') expanded.set(item.path, await readEntry(item));
    }
    const usedPaths = new Set<string>(['project.json']);
    const files: StoredFile[] = [];
    for (const mapping of manifest.files) {
      const take = (path: string, type: string) => {
        if (usedPaths.has(path) || !expanded.has(path))
          fail('Связь материала с файлом отсутствует или повторяется.');
        usedPaths.add(path);
        return new Blob([new Uint8Array(expanded.get(path)!).buffer], { type });
      };
      files.push({
        id: mapping.id,
        projectId: project.id,
        original: take(mapping.originalPath, mapping.originalType),
        ...(mapping.thumbnailPath
          ? { thumbnail: take(mapping.thumbnailPath, mapping.thumbnailType!) }
          : {}),
      });
    }
    if (usedPaths.size !== expanded.size) fail('В копии есть файлы, не связанные с материалами.');
    progress(options, { stage: 'validating' });
    validateFiles(project, files);
    progress(options, { stage: 'complete' });
    return { project, files };
  } catch (error) {
    if (error instanceof Error && /[А-Яа-яЁё]/.test(error.message)) throw error;
    fail('Не удалось прочитать резервную копию: структура или содержимое повреждены.');
  }
}
