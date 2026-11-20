import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { newProject } from '../src/domain/model';
import { newPerson } from '../src/domain/types';
import { exportArchive } from '../src/transfer/archive';

test('пять автономных запусков, размещений 80 карточек и открытий человека', async ({
  page,
  context,
}, info) => {
  test.setTimeout(90_000);
  const project = newProject('Измерение быстродействия');
  project.people = Array.from({ length: 1000 }, (_, index) =>
    newPerson(`Родственник ${index + 1}`),
  );
  project.relationships = project.people.slice(1, 100).map((person, index) => ({
    id: `family-${index}`,
    fromId: project.people[0].id,
    toId: person.id,
    kind: 'biological',
  }));
  const source = info.outputPath('timing.zip');
  await fs.writeFile(
    source,
    Buffer.from(await (await exportArchive({ project, files: [] })).arrayBuffer()),
  );
  await page.goto('/');
  await page.getByLabel('У меня уже есть резервная копия').setInputFiles(source);
  await page
    .getByRole('dialog', { name: 'Восстановить независимый архив?' })
    .getByRole('button', { name: 'Восстановить', exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(project.title);
  await expect(page.getByText('Доступно без интернета', { exact: false })).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  const launches: number[] = [];
  const trees: number[] = [];
  const cards: number[] = [];
  const heapBytes: (number | null)[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const launchStart = Date.now();
    await page.reload();
    await expect(page.locator('.family-tree')).toBeVisible();
    const treeStart = Date.now();
    await expect(page.locator('.react-flow__node')).toHaveCount(80);
    await expect(page.locator('.tree-message')).toHaveCount(0);
    trees.push(Date.now() - treeStart);
    launches.push(Date.now() - launchStart);
    heapBytes.push(
      await page.evaluate(
        () =>
          (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
            ?.usedJSHeapSize ?? null,
      ),
    );
    await page.getByRole('button', { name: 'Люди', exact: true }).click();
    await page.getByLabel('Поиск людей').fill('Родственник 1000');
    await expect(page.locator('.people-list .person-row')).toHaveCount(1);
    const cardStart = Date.now();
    await page.locator('.people-list .person-row').click();
    await expect(
      page.getByRole('heading', { name: 'Родственник 1000', exact: true }),
    ).toBeVisible();
    cards.push(Date.now() - cardStart);
  }
  await info.attach('Быстродействие без сети', {
    body: JSON.stringify({
      launchMs: launches,
      treeMs: trees,
      cardMs: cards,
      heapBytes,
      memoryScope: 'Только куча JavaScript, не вся память процесса и файлов',
    }),
    contentType: 'application/json',
  });
  expect(Math.max(...launches)).toBeLessThanOrEqual(5000);
  expect(Math.max(...trees)).toBeLessThanOrEqual(2000);
  expect(Math.max(...cards)).toBeLessThanOrEqual(1000);
});
