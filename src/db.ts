import type { Store } from './model';

const DB_NAME = 'reelbench-local-demo';
const STORE_NAME = 'app';
const CHANNEL_NAME = 'reelbench-local-demo-sync';

export function mergeStores(a: Store, b: Store): Store {
  const deletedProjectIds = [...new Set([...(a.deletedProjectIds || []), ...(b.deletedProjectIds || [])])];
  const projects = new Map(a.projects.map(p => [p.id, p]));
  for (const project of b.projects) {
    const current = projects.get(project.id);
    if (!current || project.updatedAt > current.updatedAt) projects.set(project.id, project);
  }
  const library = new Map(a.library.map(asset => [asset.id, asset]));
  for (const asset of b.library) library.set(asset.id, asset);
  return {
    projects: [...projects.values()].filter(p => !deletedProjectIds.includes(p.id)).sort((x, y) => y.updatedAt - x.updatedAt),
    library: [...library.values()],
    deletedProjectIds
  };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadStore(): Promise<Store> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get('state');
    request.onsuccess = () => resolve(request.result || { projects: [], library: [] });
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

export async function saveStore(state: Store): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    let changed = false;
    const request = store.get('state');
    request.onsuccess = () => {
      const current: Store = request.result || { projects: [], library: [] };
      const merged = mergeStores(current, state);
      changed = JSON.stringify(current) !== JSON.stringify(merged);
      if (changed) store.put(merged, 'state');
    };
    transaction.oncomplete = () => {
      db.close();
      if (changed && typeof BroadcastChannel !== 'undefined') {
        const channel = new BroadcastChannel(CHANNEL_NAME);
        channel.postMessage('updated');
        channel.close();
      }
      resolve();
    };
    transaction.onerror = () => { db.close(); reject(transaction.error); };
  });
}

export function listenForUpdates(onUpdate: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = onUpdate;
  return () => channel.close();
}
