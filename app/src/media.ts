import type { Media, StoredFile } from './domain/types';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;

export async function prepareMedia(
  file: File,
  projectId: string,
  peopleIds: string[],
): Promise<{ media: Media; file: StoredFile }> {
  if (!allowedTypes.includes(file.type as (typeof allowedTypes)[number])) {
    throw new Error('Поддерживаются JPEG, PNG, WebP и PDF. Для HEIC подготовьте JPEG.');
  }
  if (!file.size || file.size > MAX_FILE_BYTES)
    throw new Error('Выберите непустой файл размером до 25 МиБ.');
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const signature =
    file.type === 'image/jpeg'
      ? header[0] === 255 && header[1] === 216 && header[2] === 255
      : file.type === 'image/png'
        ? [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => header[i] === v)
        : file.type === 'image/webp'
          ? String.fromCharCode(...header.slice(0, 4)) === 'RIFF' &&
            String.fromCharCode(...header.slice(8, 12)) === 'WEBP'
          : String.fromCharCode(...header.slice(0, 5)) === '%PDF-';
  if (!signature)
    throw new Error('Содержимое файла не соответствует формату. Выберите другой файл.');
  const id = crypto.randomUUID();
  let thumbnail: Blob | undefined;
  if (file.type.startsWith('image/')) {
    thumbnail = await normalizeImage(file);
  }
  return {
    media: {
      id,
      name: file.name,
      mime: file.type as Media['mime'],
      size: file.size,
      caption: '',
      peopleIds,
    },
    file: { id, projectId, original: file, ...(thumbnail ? { thumbnail } : {}) },
  };
}

export async function normalizeImage(blob: Blob): Promise<Blob> {
  if (!blob.size || blob.size > MAX_FILE_BYTES)
    throw new Error('Изображение должно быть непустым и не больше 25 МиБ.');
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (
      !image.naturalWidth ||
      !image.naturalHeight ||
      image.naturalWidth * image.naturalHeight > 60_000_000
    )
      throw new Error('Изображение слишком большое или повреждено. Допустимо до 60 мегапикселей.');
    const scale = Math.min(1, 1000 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Не удалось подготовить изображение. Попробуйте другой браузер.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (result) =>
          result ? resolve(result) : reject(new Error('Не удалось подготовить фотографию.')),
        'image/jpeg',
        0.84,
      ),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
