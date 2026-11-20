import { test, expect } from '@playwright/test';
import { newProject } from '../src/domain/model';
import { newPerson } from '../src/domain/types';

test('старая блокировка удерживает миграцию до сохранения и закрытия прежнего окна', async ({
  page,
  context,
}) => {
  const project = newProject('Старая семейная база');
  project.people.push(newPerson('Сохраненный родственник'));
  const legacy: Record<string, unknown> = { ...project };
  delete legacy.trash;
  await context.addInitScript((saved) => {
    const state = window as Window & { legacyReady?: boolean; releaseLegacy?: () => void };
    void navigator.locks.request('rodoslovnaya-editor-v1', async () => {
      // Dexie хранит номер версии 1 как нативную версию IndexedDB 10.
      const request = indexedDB.open('Rodoslovnaya', 10);
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onupgradeneeded = () => {
          const projects = request.result.createObjectStore('projects', { keyPath: 'id' });
          projects.createIndex('updatedAt', 'updatedAt');
          const files = request.result.createObjectStore('files', { keyPath: ['projectId', 'id'] });
          files.createIndex('projectId', 'projectId');
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').put(saved);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      await new Promise<void>((resolve) => {
        state.releaseLegacy = () => {
          db.close();
          resolve();
        };
        state.legacyReady = true;
      });
    });
  }, legacy);
  await page.goto('/');
  await expect
    .poll(() => page.evaluate(() => (window as Window & { legacyReady?: boolean }).legacyReady))
    .toBe(true);
  await expect(
    page.getByText('Для обновления базы сохраните изменения и закройте старые окна приложения'),
  ).toBeVisible();
  const before = await page.evaluate(async () => {
    const request = indexedDB.open('Rodoslovnaya');
    return await new Promise<number>((resolve, reject) => {
      request.onsuccess = () => {
        const db = request.result;
        resolve(db.version);
        db.close();
      };
      request.onerror = () => reject(request.error);
    });
  });
  expect(before).toBe(10);
  await page.evaluate(() => (window as Window & { releaseLegacy?: () => void }).releaseLegacy?.());
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Старая семейная база');
  await page.getByRole('button', { name: 'Люди', exact: true }).click();
  await expect(page.getByRole('button', { name: /Сохраненный родственник/ })).toBeVisible();
  const upgraded = await page.evaluate(async (id) => {
    const request = indexedDB.open('Rodoslovnaya');
    return await new Promise<{ version: number; trash: unknown }>((resolve, reject) => {
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction('projects').objectStore('projects').get(id);
        read.onsuccess = () => {
          resolve({ version: db.version, trash: read.result.trash });
          db.close();
        };
        read.onerror = () => reject(read.error);
      };
      request.onerror = () => reject(request.error);
    });
  }, project.id);
  expect(upgraded).toEqual({ version: 20, trash: [] });
});
