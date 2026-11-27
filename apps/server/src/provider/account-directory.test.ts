import { describe, expect, it, vi } from 'vitest';
import { readDirectoryMembership, readDirectoryProfiles } from './account-directory.js';
import { ProviderError } from './http.js';

const origin = 'https://stripchat.com';
const small = 'https://img.doppiocdn.org/model.jpg';
const large = 'https://img.doppiocdn.org/large.jpg';
const avatar = 'https://static-cdn.strpst.com/avatar.jpg';
const requested = (path: string) => [...new URL(path, origin).searchParams.values()].map(Number);

describe('directory metadata sources', () => {
  it('reads only the selected fields from each exact-ID source', async () => {
    const read = vi.fn((path: string) => {
      const { pathname } = new URL(path, origin);
      switch (pathname) {
        case '/api/front/v2/users':
          return Promise.resolve({
            items: [{ id: 42, username: 'confirmed', avatarUrl: large }],
          });
        case '/api/front/v2/users/profiles':
          return Promise.resolve({
            items: {
              42: { username: 'profile-name', avatarUrl: avatar, previewUrlThumbSmall: large },
            },
          });
        case '/api/front/models/list':
          return Promise.resolve({
            models: [
              {
                id: 42,
                username: 'card-name',
                avatarUrl: large,
                previewUrlThumbSmall: small,
                isInFavorites: false,
              },
              { id: 71, isInFavorites: true },
            ],
          });
        default:
          return Promise.reject(new Error('unexpected directory endpoint'));
      }
    });

    const result = await readDirectoryProfiles(read, [42], undefined, {
      followingIds: new Set([71]),
    });
    expect(result.profiles).toEqual(
      new Map([[42, { handle: 'confirmed', avatarSourceUrl: avatar, previewSourceUrl: small }]]),
    );
    expect(result.membership).toEqual(new Map([[42, false]]));
    expect(read.mock.calls.map(([path]) => requested(path))).toEqual([[42], [42], [42, 71]]);
  });

  it('leaves absent, inaccessible and mismatched fields unset', async () => {
    const read = vi.fn((path: string) => {
      const { pathname } = new URL(path, origin);
      switch (pathname) {
        case '/api/front/v2/users':
          return Promise.reject(new ProviderError('upstream-http', 403));
        case '/api/front/v2/users/profiles':
          return Promise.resolve({ items: { 42: { id: 43, avatarUrl: avatar } } });
        case '/api/front/models/list':
          return Promise.resolve({
            models: [
              { id: 42, username: 'other-name', avatarUrl: avatar, previewUrlThumbBig: large },
            ],
          });
        default:
          return Promise.reject(new Error('unexpected directory endpoint'));
      }
    });
    const result = await readDirectoryProfiles(read, [42, 77]);
    expect(result.profiles.size).toBe(0);
    expect(result.membership.size).toBe(0);
  });

  it('requires a known favorite in the same card response before accepting a negative', async () => {
    const weak = vi.fn(() =>
      Promise.resolve({
        models: [
          { id: 42, isInFavorites: false },
          { id: 71, isInFavorites: false },
        ],
      }),
    );
    expect((await readDirectoryMembership(weak, [42], new Set([71]))).size).toBe(0);

    const verified = vi.fn((path: string) => {
      expect(path).toContain('/api/front/models/list?');
      return Promise.resolve({
        models: [
          { id: 42, isInFavorites: false },
          { id: 71, isInFavorites: true },
        ],
      });
    });
    expect(await readDirectoryMembership(verified, [42, 43], new Set([71]))).toEqual(
      new Map([[42, false]]),
    );
    expect(verified).toHaveBeenCalledTimes(1);
  });

  it('does not exceed the card request limit when adding known favorite controls', async () => {
    const ids = Array.from({ length: 70 }, (_, i) => i + 1);
    const controls = new Set([901, 902, 903]);
    const read = vi.fn((path: string) => {
      const ids = requested(path);
      return Promise.resolve({
        models: ids.map((id) => ({ id, isInFavorites: controls.has(id) })),
      });
    });
    const result = await readDirectoryMembership(read, ids, controls);
    expect(result.size).toBe(ids.length);
    expect(read.mock.calls.every(([path]) => requested(path).length <= 50)).toBe(true);
  });
});
