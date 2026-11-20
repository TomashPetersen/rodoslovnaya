import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { newProject } from '../src/domain/model';
import { newPerson } from '../src/domain/types';
import { exportArchive, importArchive } from '../src/transfer/archive';

test('100 человек, 50 фотографий и 100 МБ оригиналов сохраняются без потерь', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'chromium', 'Объем проверяется отдельно от имитации телефона.');
  test.setTimeout(180_000);
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'rodoslovnaya-volume-'));
  const project = newProject('Проверка объема');
  project.people = Array.from({ length: 100 }, (_, index) => newPerson(`Родственник ${index + 1}`));
  const png = await fs.readFile(path.resolve('public/icon-192.png'));
  const original = Buffer.alloc(2_000_000);
  png.copy(original);
  const expectedHash = createHash('sha256').update(original).digest('hex');
  project.media = Array.from({ length: 50 }, (_, index) => ({
    id: `volume-${index}`,
    name: `photo-${index + 1}.png`,
    mime: 'image/png' as const,
    size: original.length,
    caption: `Фотография ${index + 1}`,
    peopleIds: [project.people[index].id],
  }));
  const files = project.media.map((material) => ({
    id: material.id,
    projectId: project.id,
    original: new Blob([original], { type: 'image/png' }),
    thumbnail: new Blob([png], { type: 'image/png' }),
  }));
  const archive = await exportArchive({ project, files });
  const input = path.join(work, 'input.zip');
  await fs.writeFile(input, Buffer.from(await archive.arrayBuffer()));
  await page.goto('/');
  const start = Date.now();
  await page.getByLabel('У меня уже есть резервная копия').setInputFiles(input);
  await page
    .getByRole('dialog', { name: 'Восстановить независимый архив?' })
    .getByRole('button', { name: 'Восстановить', exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Проверка объема', {
    timeout: 60_000,
  });
  const importMs = Date.now() - start;
  const readHeap = () =>
    page.evaluate(
      () =>
        (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
          ?.usedJSHeapSize ?? null,
    );
  const heapAfterImport = await readHeap();
  await page.getByRole('button', { name: 'Архив', exact: true }).click();
  let downloads = 0;
  page.on('download', () => {
    downloads++;
  });
  await page.getByRole('button', { name: 'Скачать полную копию', exact: true }).click();
  await page.getByRole('button', { name: 'Отменить операцию', exact: true }).click();
  await expect(
    page.getByText('Операция отменена. Сохраненные данные не изменены.', { exact: true }),
  ).toBeVisible();
  expect(downloads).toBe(0);
  const startedExport = Date.now();
  const pending = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Скачать полную копию', exact: true }).click();
  const download = await pending;
  const resultPath = path.join(work, 'output.zip');
  await download.saveAs(resultPath);
  const exportMs = Date.now() - startedExport;
  const heapAfterExport = await readHeap();
  const exported = await fs.readFile(resultPath);
  const restored = await importArchive(new Blob([exported]));
  expect(restored.project.people).toHaveLength(100);
  expect(restored.files).toHaveLength(50);
  expect(restored.files.reduce((sum, file) => sum + file.original.size, 0)).toBe(100_000_000);
  for (const file of restored.files) {
    expect(
      createHash('sha256')
        .update(Buffer.from(await file.original.arrayBuffer()))
        .digest('hex'),
    ).toBe(expectedHash);
  }
  await info.attach('Измерения объема', {
    body: JSON.stringify({
      people: 100,
      files: 50,
      originalBytes: 100_000_000,
      zipBytes: exported.length,
      importMs,
      exportMs,
      heapAfterImport,
      heapAfterExport,
      memoryScope:
        'Куча JavaScript основной страницы; не пиковая память процесса, файлов или вычислительного потока',
      artifacts: work,
    }),
    contentType: 'application/json',
  });
});

test('поиск по тысяче людей возвращает нужную карточку', async ({ page }, info) => {
  const project = newProject('Тысяча родственников');
  project.people = Array.from({ length: 1000 }, (_, index) =>
    newPerson(`Родственник ${index + 1}`),
  );
  const file = info.outputPath('thousand.zip');
  const archive = await exportArchive({ project, files: [] });
  await fs.writeFile(file, Buffer.from(await archive.arrayBuffer()));
  await page.goto('/');
  await page.getByLabel('У меня уже есть резервная копия').setInputFiles(file);
  await page
    .getByRole('dialog', { name: 'Восстановить независимый архив?' })
    .getByRole('button', { name: 'Восстановить', exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Тысяча родственников');
  await page.getByRole('button', { name: 'Люди', exact: true }).click();
  const search = page.getByLabel('Поиск людей');
  const measurements: number[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    await search.fill('');
    const start = Date.now();
    await search.fill('Родственник 1000');
    await expect(page.locator('.people-list .person-row')).toHaveCount(1);
    await expect(page.locator('.people-list .person-row')).toContainText('Родственник 1000');
    measurements.push(Date.now() - start);
  }
  await info.attach('Время поиска', {
    body: JSON.stringify({
      measurementsMs: measurements,
      medianMs: [...measurements].sort((a, b) => a - b)[2],
      worstMs: Math.max(...measurements),
    }),
    contentType: 'application/json',
  });
  expect(Math.max(...measurements)).toBeLessThanOrEqual(500);
});
