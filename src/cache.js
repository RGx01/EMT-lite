// The month cache (design §6): what Octopus returned for a month, kept on the user's device so a
// settled month is not asked again. Only when the user ticked "Remember me"; "Sign out" deletes it.
// Nothing here leaves the browser.

import { midnight, addDays } from './time.js';

const DB = 'emt-lite';
const STORE = 'months';

// Bump when the stored shape of a month changes: older entries are then fetched again.
export const CACHE_SHAPE = 1;

// A month is settled once it has been over this long: Octopus's late readings, its cost recovery
// and its House/EV split revisions (EMT holds a split back up to 28 days) have had their time.
export const SETTLE_DAYS = 35;

/** Can a cached month be used as it is? Only if it was fetched once the month had settled. */
export function reusable(entry, month) {
  return !!entry && entry.shape === CACHE_SHAPE && Number(entry.fetchedAt) >= midnight(addDays(month.end, SETTLE_DAYS));
}

export function monthKey(info, month) {
  return [info.number, info.import?.mpan || '', info.export?.mpan || '', month.start].join('|');
}

/** In memory, for tests. */
export function memoryCache() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? structuredClone(m.get(k)) : null; },
    async put(k, v) { m.set(k, structuredClone(v)); },
    size: () => m.size,
    async close() {},
  };
}

/** IndexedDB on this device. Any failure (a private window, storage refused) leaves it a no-op:
 *  the page then simply asks Octopus, as without the cache. */
export function deviceCache() {
  let dbp = null;
  const open = () => (dbp = dbp || new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  }));
  const run = async (mode, fn) => {
    const db = await open();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result ?? null);
        tx.onerror = tx.onabort = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  };
  return {
    get: (k) => run('readonly', (s) => s.get(k)),
    put: (k, v) => run('readwrite', (s) => s.put(v, k)),
    // an open connection blocks deleting the database: Sign out closes it first
    async close() { const db = await dbp; db?.close(); dbp = Promise.resolve(null); },
  };
}

/** Delete everything EMT-Lite stored on this device's IndexedDB. */
export function deleteDeviceCache() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(DB);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}
