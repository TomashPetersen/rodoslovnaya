import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import { newProject } from '../src/domain/model';
import { newPerson } from '../src/domain/types';
import { exportArchive } from '../src/transfer/archive';

async function createArchive(page: Page, navigate = true) {
  if (navigate) await page.goto('/');
  await page.getByLabel('Имя первого человека').fill('Начальный Человек');
  await page.getByRole('button', { name: 'Начать семейный архив', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Моя семья');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

async function addPerson(page: Page, name: string) {
  await page.getByRole('button', { name: '+ Добавить человека', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Имя и фамилия').fill(name);
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

test('семья, фотография, рассказ, архив и независимое восстановление', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:4173'))
      externalRequests.push(request.url());
  });
  await createArchive(page);
  await addPerson(page, 'Анна Тестовая');
  await page.getByLabel('Статус жизни').selectOption('deceased');
  await page.getByLabel('Дата рождения').fill('~1930');
  await expect(
    page.getByRole('status').filter({ hasText: 'Сохранено в приложении' }),
  ).toBeVisible();
  await addPerson(page, 'Петр Тестовый');
  await page.getByRole('button', { name: 'Добавить родственника', exact: true }).click();
  const relationDialog = page.getByRole('dialog');
  await relationDialog.getByRole('button', { name: 'Уже есть в архиве' }).click();
  await relationDialog.getByLabel('Кого добавляем').selectOption('parent');
  await relationDialog
    .getByRole('combobox', { name: 'Человек', exact: true })
    .selectOption({ label: 'Анна Тестовая' });
  await relationDialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(relationDialog).not.toBeVisible();
  await page.getByRole('button', { name: 'Дерево', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Открыть карточку: Анна Тестовая', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Открыть карточку: Петр Тестовый', exact: true }),
  ).toBeVisible();
  await page.locator('.tree-canvas').scrollIntoViewIfNeeded();
  await page.locator('.tree-canvas').screenshot({ path: test.info().outputPath('tree.png') });
  await page.getByRole('button', { name: 'Материалы', exact: true }).click();
  await page.getByLabel('Фильтр материалов').selectOption({ label: 'Анна Тестовая' });
  await page
    .getByLabel('Добавить фото или документ')
    .setInputFiles(path.resolve('../research-data/fixtures/photo-1.png'));
  await expect(page.getByText('Материал сохранен вместе с оригиналом.')).toBeVisible();
  await page.getByLabel('Подпись photo-1.png').fill('Семейная фотография');
  await page.getByRole('button', { name: 'Написать историю', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Название истории').fill('Воспоминание о доме');
  await page
    .getByRole('dialog')
    .getByLabel('Воспоминание', { exact: true })
    .fill('Семья собиралась за большим столом.');
  await page.getByRole('dialog').getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Воспоминание о доме' })).toBeVisible();
  await page.getByRole('button', { name: 'Архив', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать полную копию', exact: true }).click();
  const downloaded = await downloadEvent;
  const archivePath = test.info().outputPath('family.zip');
  await downloaded.saveAs(archivePath);
  expect((await fs.stat(archivePath)).size).toBeGreaterThan(1000);
  await page.getByRole('button', { name: 'Семейный выпуск', exact: true }).click();
  await page.getByRole('button', { name: 'Выбрать все подходящие', exact: true }).click();
  await page.getByRole('button', { name: 'Предварительный просмотр', exact: true }).click();
  const frame = page.frameLocator('iframe[title="Предварительный просмотр семейного выпуска"]');
  await expect(frame.getByRole('heading', { name: 'Анна Тестовая', exact: true })).toBeVisible();
  await expect(frame.getByText('Петр Тестовый')).toHaveCount(0);
  await expect(frame.getByText('Семья собиралась за большим столом.')).toBeVisible();
  const editionDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать выпуск HTML' }).click();
  const editionFile = await editionDownload;
  const editionPath = test.info().outputPath('edition.html');
  await editionFile.saveAs(editionPath);
  const html = await fs.readFile(editionPath, 'utf8');
  expect(html).not.toContain('Петр Тестовый');
  expect(html).toContain('data:image/jpeg;base64,');
  await page.getByRole('button', { name: 'Копии', exact: true }).click();
  await page.getByLabel('Восстановить из копии').setInputFiles(archivePath);
  await page.getByRole('dialog').getByRole('button', { name: 'Восстановить', exact: true }).click();
  await expect(page.getByText('Целостность копии проверена.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Архив', exact: true }).click();
  await expect(page.getByLabel('Открытый архив').locator('option')).toHaveCount(2);
  await page.reload();
  await expect(page.getByText('Людей: 3', { exact: false }).first()).toBeVisible();
  expect(externalRequests).toEqual([]);
  expect(failures).toEqual([]);
});

test('смена статуса на живого требует нового явного включения в выпуск', async ({ page }) => {
  await createArchive(page);
  await addPerson(page, 'Проверка Приватности');
  await page.getByLabel('Статус жизни').selectOption('deceased');
  await expect(
    page.getByRole('status').filter({ hasText: 'Сохранено в приложении' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Архив', exact: true }).click();
  await page.getByRole('button', { name: 'Семейный выпуск', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /Проверка Приватности/ })).toBeChecked();
  await page.getByRole('button', { name: 'Люди', exact: true }).click();
  await page.getByRole('button', { name: /Проверка Приватности/ }).click();
  await page.getByLabel('Статус жизни').selectOption('alive');
  await expect(
    page.getByRole('status').filter({ hasText: 'Сохранено в приложении' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Архив', exact: true }).click();
  await page.getByRole('button', { name: 'Семейный выпуск', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /Проверка Приватности/ })).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Предварительный просмотр' })).toBeDisabled();
});

test('выпуск перекодирует импортированное изображение и удаляет скрытые метаданные', async ({
  page,
}) => {
  const project = newProject('Проверка метаданных');
  const person = { ...newPerson('Предок без скрытых сведений'), lifeStatus: 'deceased' as const };
  project.people.push(person);
  const png = await fs.readFile(path.resolve('public/icon-192.png'));
  const marker = 'GPS_SECRET_46_35';
  const thumbnail = Buffer.concat([png, Buffer.from(marker)]);
  project.media.push({
    id: 'photo',
    name: 'private-name.png',
    mime: 'image/png',
    size: png.length,
    caption: '',
    peopleIds: [person.id],
  });
  const archive = await exportArchive({
    project,
    files: [
      {
        id: 'photo',
        projectId: project.id,
        original: new Blob([png], { type: 'image/png' }),
        thumbnail: new Blob([thumbnail], { type: 'image/png' }),
      },
    ],
  });
  const archivePath = test.info().outputPath('metadata.zip');
  await fs.writeFile(archivePath, Buffer.from(await archive.arrayBuffer()));
  await createArchive(page);
  await page.getByRole('button', { name: 'Архив', exact: true }).click();
  await page.getByLabel('Восстановить из копии').setInputFiles(archivePath);
  await page.getByRole('dialog').getByRole('button', { name: 'Восстановить', exact: true }).click();
  await expect(page.getByText('Целостность копии проверена.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Архив', exact: true }).click();
  await page.getByRole('button', { name: 'Семейный выпуск', exact: true }).click();
  await page.getByRole('button', { name: 'Выбрать все подходящие', exact: true }).click();
  await page.getByRole('button', { name: 'Предварительный просмотр', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать выпуск HTML' }).click();
  const result = await downloadEvent;
  const htmlPath = test.info().outputPath('clean-edition.html');
  await result.saveAs(htmlPath);
  const html = await fs.readFile(htmlPath, 'utf8');
  const images = [...html.matchAll(/data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/g)];
  expect(images.length).toBeGreaterThan(0);
  for (const match of images)
    expect(Buffer.from(match[1], 'base64').includes(Buffer.from(marker))).toBe(false);
  expect(html).not.toContain('private-name.png');
});

test('сохраненная карточка доступна после запуска без сети', async ({ page, context }) => {
  await createArchive(page);
  await addPerson(page, 'Сохраненная Персона');
  await page.getByLabel('Дата рождения').fill('1987-02-03');
  await expect(
    page.getByRole('status').filter({ hasText: 'Сохранено в приложении' }),
  ).toBeVisible();
  await expect(page.getByText('Доступно без интернета', { exact: false })).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: 'Люди', exact: true }).click();
  await page.getByRole('button', { name: /Сохраненная Персона/ }).click();
  await expect(page.getByLabel('Дата рождения')).toHaveValue('1987-02-03');
  await page.getByRole('button', { name: 'Архив', exact: true }).click();
  const offlineDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать полную копию', exact: true }).click();
  const offlineCopy = await offlineDownload;
  const offlineCopyPath = test.info().outputPath('offline-copy.zip');
  await offlineCopy.saveAs(offlineCopyPath);
  expect((await fs.stat(offlineCopyPath)).size).toBeGreaterThan(100);
  await context.setOffline(false);
});

test('второе окно читает архив и получает право записи после закрытия первого', async ({
  page,
  context,
}) => {
  await createArchive(page);
  await addPerson(page, 'Первый Человек');
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.getByText('Режим чтения.', { exact: false })).toBeVisible();
  await expect(
    second.getByRole('button', { name: '+ Добавить человека', exact: true }),
  ).toBeDisabled();
  await page.getByLabel('Дата рождения').fill('1950');
  await expect(
    page.getByRole('status').filter({ hasText: 'Сохранено в приложении' }),
  ).toBeVisible();
  await page.close();
  await expect(
    second.getByRole('button', { name: '+ Добавить человека', exact: true }),
  ).toBeEnabled();
  await second.getByRole('button', { name: 'Люди', exact: true }).click();
  await second.getByRole('button', { name: /Первый Человек/ }).click();
  await expect(second.getByLabel('Дата рождения')).toHaveValue('1950');
  await second.getByLabel('Дата рождения').fill('1951');
  await expect(
    second.getByRole('status').filter({ hasText: 'Сохранено в приложении' }),
  ).toBeVisible();
});

test('второе окно обнаруживает архив, созданный после его открытия', async ({ page, context }) => {
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Начать семейный архив', exact: true }),
  ).toBeEnabled();
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.getByText('Режим чтения.', { exact: false })).toBeVisible();
  await createArchive(page, false);
  await addPerson(page, 'Новый Для Второго Окна');
  await page.close();
  await expect(
    second.getByRole('button', { name: '+ Добавить человека', exact: true }),
  ).toBeEnabled();
  await second.getByRole('button', { name: 'Люди', exact: true }).click();
  await expect(second.getByRole('button', { name: /Новый Для Второго Окна/ })).toBeVisible();
});
