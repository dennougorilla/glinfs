import { describe, expect, it, vi } from 'vitest';
import {
  estimateStorageUsage,
  isStoragePersistent,
  requestPersistentStorage,
} from '../../../src/features/ai-cutout/model-storage.js';

describe('requestPersistentStorage', () => {
  it('asks only when storage is not persistent yet', async () => {
    const persist = vi.fn(async () => true);
    await expect(requestPersistentStorage({ persisted: async () => false, persist })).resolves.toBe(
      true,
    );
    expect(persist).toHaveBeenCalledTimes(1);

    const again = vi.fn(async () => true);
    await expect(
      requestPersistentStorage({ persisted: async () => true, persist: again }),
    ).resolves.toBe(true);
    expect(again).not.toHaveBeenCalled();
  });

  it('is guarded: no StorageManager, no persist(), a refusal or a throw', async () => {
    await expect(requestPersistentStorage(undefined)).resolves.toBeNull();
    await expect(requestPersistentStorage({})).resolves.toBeNull();
    await expect(requestPersistentStorage({ persist: async () => false })).resolves.toBe(false);
    await expect(
      requestPersistentStorage({
        persist: async () => {
          throw new Error('denied');
        },
      }),
    ).resolves.toBeNull();
  });
});

describe('isStoragePersistent / estimateStorageUsage', () => {
  it('reads the state, null when unknown', async () => {
    await expect(isStoragePersistent({ persisted: async () => true })).resolves.toBe(true);
    await expect(isStoragePersistent({})).resolves.toBeNull();
    await expect(
      estimateStorageUsage({ estimate: async () => ({ usage: 1234, quota: 1e9 }) }),
    ).resolves.toBe(1234);
    await expect(estimateStorageUsage({ estimate: async () => ({}) })).resolves.toBeNull();
    await expect(estimateStorageUsage(undefined)).resolves.toBeNull();
  });
});
