import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import { importArchive } from '../src/transfer/archive';

async function start(page: Page) {
  await page.goto('/');
  await page.getByLabel('Имя первого человека').fill('Анна Семейная');
  await page.getByRole('button', { name: 'Начать семейный архив', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Анна Семейная', exact: true })).toBeVisible();
}

test('ошибка рассказа оставляет аварийную копию доступной прямо из формы', async ({
  page,
}, info) => {
  await start(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'projects')
        throw new DOMException('Отказ записи рассказа', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
  await page.getByRole('button', { name: 'Написать историю', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Написать историю', exact: true });
  await dialog.getByLabel('Название истории').fill('История, которую нельзя потерять');
  await dialog
    .getByLabel('Воспоминание', { exact: true })
    .fill('Несохраненный рассказ остается в форме');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.getByText('Отказ записи рассказа', { exact: false })).toBeVisible();
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Скачать сохраненные данные', exact: true }).click();
  const downloaded = await pending;
  const file = info.outputPath('copy-from-dialog.zip');
  await downloaded.saveAs(file);
  expect((await importArchive(new Blob([await fs.readFile(file)]))).project.stories).toEqual([]);
  await expect(dialog.getByLabel('Воспоминание', { exact: true })).toHaveValue(
    'Несохраненный рассказ остается в форме',
  );
});

test('изменение версии базы прекращает запись, сохраняя доступный незавершенный ввод', async ({
  page,
}, info) => {
  await start(page);
  await page.getByText('Другие сведения', { exact: true }).click();
  await page.getByLabel('Что известно о человеке').fill('Текст, оставшийся при смене версии');
  await page.getByLabel('Дата рождения').fill('1930-02-31');
  await page.evaluate(async () => {
    const request = indexedDB.open('Rodoslovnaya', 21);
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  });
  await expect(
    page.getByText('Структура базы изменилась.', { exact: false }).first(),
  ).toBeVisible();
  await expect(page.getByLabel('Что известно о человеке')).toHaveValue(
    'Текст, оставшийся при смене версии',
  );
  await expect(page.getByLabel('Дата рождения')).toHaveValue('1930-02-31');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать незавершенный ввод', exact: true }).click();
  const file = info.outputPath('unfinished-input.json');
  await (await pending).saveAs(file);
  const text = await fs.readFile(file, 'utf8');
  expect(text).toContain('Текст, оставшийся при смене версии');
  expect(text).toContain('1930-02-31');
});

test('возврат от другого узла восстанавливает корень и положение дерева', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: 'Добавить родственника', exact: true }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('Имя родственника').fill('Борис Родитель');
  await form.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(form).not.toBeVisible();
  await page.getByRole('button', { name: 'Люди', exact: true }).click();
  await page.getByRole('button', { name: /Анна Семейная/ }).click();
  await page.getByRole('button', { name: 'Дерево', exact: true }).click();
  const canvas = page.locator('.tree-canvas');
  await expect(
    canvas.getByRole('button', { name: 'Открыть карточку: Борис Родитель' }),
  ).toBeVisible();
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 24, box.y + 28);
  await page.mouse.down();
  await page.mouse.move(box.x + 70, box.y + 58, { steps: 4 });
  await page.mouse.up();
  const viewport = page.locator('.react-flow__viewport');
  const transform = await viewport.getAttribute('style');
  await canvas.getByRole('button', { name: 'Открыть карточку: Борис Родитель' }).click();
  await expect(page.getByRole('heading', { name: 'Борис Родитель', exact: true })).toBeVisible();
  const back = page.getByRole('button', { name: '← Назад', exact: true });
  if (await back.isVisible()) await back.click();
  await expect(page.locator('.tree-person-active')).toContainText('Анна Семейная');
  await expect(viewport).toHaveAttribute('style', transform!);
});

test('возврат из списка восстанавливает камеру, а новая карточка не использует старую историю', async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== 'mobile-chromium',
    'Отдельный экран карточки и команда возврата проверяются на телефоне.',
  );
  await start(page);
  await page.getByRole('button', { name: 'Добавить родственника', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Имя родственника').fill('Борис Родитель');
  await page.getByRole('dialog').getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByRole('button', { name: 'Люди', exact: true }).click();
  await page.getByRole('button', { name: /Анна Семейная/ }).click();
  await page.getByRole('button', { name: 'Дерево', exact: true }).click();
  const canvas = page.locator('.tree-canvas');
  await expect(
    canvas.getByRole('button', { name: 'Открыть карточку: Борис Родитель' }),
  ).toBeVisible();
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 24, box.y + 28);
  await page.mouse.down();
  await page.mouse.move(box.x + 70, box.y + 58, { steps: 4 });
  await page.mouse.up();
  const viewport = page.locator('.react-flow__viewport');
  const transform = await viewport.getAttribute('style');
  await page.getByRole('button', { name: 'Люди', exact: true }).click();
  await page.getByLabel('Поиск людей').fill('Борис');
  await page.getByRole('button', { name: /Борис Родитель/ }).click();
  await page.getByRole('button', { name: '← Назад', exact: true }).click();
  await page.getByRole('button', { name: 'Дерево', exact: true }).click();
  await expect(page.locator('.tree-person-active')).toContainText('Анна Семейная');
  await expect(viewport).toHaveAttribute('style', transform!);
  await canvas.getByRole('button', { name: 'Открыть карточку: Борис Родитель' }).click();
  await page.getByRole('button', { name: 'Люди', exact: true }).click();
  await page.getByRole('button', { name: '+ Добавить человека', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Имя и фамилия').fill('Вера Новая');
  await page.getByRole('dialog').getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Вера Новая', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '← Назад', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Люди в вашей истории', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Поиск людей')).toHaveValue('Борис');
  await expect(canvas).not.toBeVisible();
});
