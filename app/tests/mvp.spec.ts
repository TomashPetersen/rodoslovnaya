import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import { importArchive } from '../src/transfer/archive';

async function start(page: Page) {
  await page.goto('/');
  await page.getByLabel('Имя первого человека').fill('Анна Семейная');
  await page.getByRole('button', { name: 'Начать семейный архив', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Моя семья');
  await expect(page.getByRole('heading', { name: 'Анна Семейная', exact: true })).toBeVisible();
}

async function saved(page: Page) {
  await expect(
    page.getByRole('status').filter({ hasText: 'Сохранено в приложении' }),
  ).toBeVisible();
}

test('возврат ошибочного поля сохраняет другие сведения', async ({ page }) => {
  await start(page);
  await page.getByText('Другие сведения', { exact: true }).click();
  await page.getByLabel('Что известно о человеке').fill('Сохраненная семейная история');
  await saved(page);
  await page.getByLabel('Дата рождения').fill('1930-02-31');
  await expect(page.getByLabel('Дата рождения')).toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('button', { name: 'Вернуть сохраненное значение', exact: true }).click();
  await expect(page.getByLabel('Дата рождения')).toHaveValue('');
  await expect(page.getByLabel('Что известно о человеке')).toHaveValue(
    'Сохраненная семейная история',
  );
  await page.reload();
  await page.getByRole('button', { name: 'Люди', exact: true }).click();
  await page.getByRole('button', { name: /Анна Семейная/ }).click();
  await page.getByText('Другие сведения', { exact: true }).click();
  await expect(page.getByLabel('Что известно о человеке')).toHaveValue(
    'Сохраненная семейная история',
  );
});

test('неверный черновик требует явного решения перед переходом', async ({ page }) => {
  await start(page);
  await page.getByLabel('Дата рождения').fill('1930-02-31');
  await page.getByRole('button', { name: 'Люди', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Есть неверно заполненные поля' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Отбросить неверный ввод', exact: true }).click();
  await page.getByRole('button', { name: /Анна Семейная/ }).click();
  await expect(page.getByLabel('Дата рождения')).toHaveValue('');
});

test('корзина доступна после удаления последнего человека и перезапуска', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: 'Удалить человека в корзину', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'В корзину', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Архив', exact: true }).click();
  await page.getByRole('button', { name: 'Корзина', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Анна Семейная', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Восстановить', exact: true }).click();
  await page.getByRole('button', { name: 'Люди', exact: true }).click();
  await page.getByRole('button', { name: /Анна Семейная/ }).click();
  await expect(page.getByRole('heading', { name: 'Анна Семейная', exact: true })).toBeVisible();
});

test('постоянный отказ записи не блокирует копирование сохраненного снимка', async ({
  page,
}, info) => {
  await start(page);
  await page.getByText('Другие сведения', { exact: true }).click();
  await page.getByLabel('Что известно о человеке').fill('Успешно записано до отказа');
  await saved(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'projects')
        throw new DOMException('Испытательный отказ записи', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
  await page.getByLabel('Что известно о человеке').fill('Несохраненный новый текст');
  await expect(
    page.getByText('Испытательный отказ записи', { exact: false }).first(),
  ).toBeVisible();
  const pending = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Скачать сохраненные данные', exact: true })
    .first()
    .click();
  const downloaded = await pending;
  const file = info.outputPath('saved-during-error.zip');
  await downloaded.saveAs(file);
  const snapshot = await importArchive(new Blob([await fs.readFile(file)]));
  expect(snapshot.project.people[0].biography).toBe('Успешно записано до отказа');
  await expect(page.getByLabel('Что известно о человеке')).toHaveValue('Несохраненный новый текст');
  await page.getByLabel('Что известно о человеке').fill('Успешно записано до отказа');
  await page.getByRole('button', { name: 'Люди', exact: true }).click();
  await expect(page.getByRole('button', { name: /Анна Семейная/ })).toBeVisible();
});

test('основные экраны помещаются на телефоне и сохраняют положение дерева', async ({
  page,
}, info) => {
  await start(page);
  const back = page.getByRole('button', { name: '← Назад', exact: true });
  if (await back.isVisible()) await back.click();
  await page.getByLabel('Поколений предков').selectOption('2');
  const canvas = page.locator('.tree-canvas');
  await expect
    .poll(() =>
      canvas.locator('.react-flow').evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBeGreaterThanOrEqual(399);
  await expect(
    canvas.getByRole('button', { name: 'Открыть карточку: Анна Семейная' }),
  ).toBeVisible();
  await expect(
    canvas.getByRole('button', { name: 'Открыть карточку: Анна Семейная' }),
  ).toBeInViewport({ ratio: 1 });
  const viewport = page.locator('.react-flow__viewport');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 24, box.y + 28);
  await page.mouse.down();
  await page.mouse.move(box.x + 70, box.y + 58, { steps: 4 });
  await page.mouse.up();
  const transform = await viewport.getAttribute('style');
  await canvas.getByRole('button', { name: 'Открыть карточку: Анна Семейная' }).click();
  await page.getByRole('button', { name: 'Фотографии и истории', exact: true }).click();
  await page.getByRole('button', { name: '← К карточке', exact: true }).click();
  if (await back.isVisible()) await back.click();
  await expect(page.getByLabel('Поколений предков')).toHaveValue('2');
  await expect(viewport).toHaveAttribute('style', transform!);
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    for (const section of ['Дерево', 'Люди', 'Материалы', 'Архив']) {
      await page.getByRole('button', { name: section, exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  }
  await page.getByRole('button', { name: 'Дерево', exact: true }).click();
  await expect(
    canvas.getByRole('button', { name: 'Открыть карточку: Анна Семейная' }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath('mvp-full.png'), fullPage: true });
});
