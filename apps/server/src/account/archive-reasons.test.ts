import { describe, expect, it, vi } from 'vitest';
import type { AccountSyncStatus, ArchiveReason, Subject } from '@st-vault/api-schema';
import type { UnfollowedSubjectResult } from '../ports.js';
import { SyncClock } from '../runtime/sync-clock.js';
import { ProviderError } from '../provider/http.js';
import { createArchiveReasons } from './archive-reasons.js';

function row(providerId: number, archived = true): Subject {
  return {
    id: `stripchat:${providerId}`,
    providerId,
    handle: `fixture-${providerId}`,
    monitorEnabled: !archived,
    autoRecord: false,
    archived,
    providerStatus: 'UNKNOWN',
    observedAtMs: null,
  };
}

async function fixture(
  run: (f: ReturnType<typeof setup>) => Promise<void>,
  blockedCleanup = false,
) {
  const f = setup(blockedCleanup);
  try {
    await run(f);
  } finally {
    await f.reasons.close();
    await f.clock.close();
  }
}

function setup(blockedCleanup: boolean) {
  let now = 10_000;
  let transport = new AbortController();
  const clock = new SyncClock({ intervalMs: () => 300_000, now: () => now });
  const rows = [row(1), row(2), row(3, false)];
  const account = {
    origin: 'https://stripchat.com',
    connected: true,
    needsReconnect: false,
    running: false,
    lastSuccessMs: now,
    profile: null as AccountSyncStatus['profile'],
  };
  const listeners = new Set<() => void>();
  const probe = vi
    .fn<(...args: [string, number, AbortSignal]) => Promise<ArchiveReason | null>>()
    .mockResolvedValue(null);
  const unfollowBlocked = vi
    .fn<(id: number, signal: AbortSignal) => Promise<void>>()
    .mockResolvedValue(undefined);
  const onUpdated = vi.fn();
  const listSubjects = vi.fn(() => Promise.resolve(rows));
  const accountActivation = vi.fn(() => Promise.resolve('fixture-generation'));
  const recordVerifiedUnfollowed = vi
    .fn<() => Promise<UnfollowedSubjectResult>>()
    .mockResolvedValue('retained');
  const recordVerifiedBlocked = vi
    .fn<
      (
        id: string,
        generation: string,
        removeFavorite: () => Promise<void>,
      ) => Promise<UnfollowedSubjectResult>
    >()
    .mockResolvedValue('retained');
  const cleanupBlocked = vi.fn(async (id: string, providerId: number, signal: AbortSignal) =>
    recordVerifiedBlocked(id, await accountActivation(), () => unfollowBlocked(providerId, signal)),
  );
  const openProbe = vi.fn((origin: string) => {
    const read = (id: number, signal: AbortSignal) => probe(origin, id, signal);
    return Promise.resolve(blockedCleanup ? Object.assign(read, { cleanupBlocked }) : read);
  });
  const acceptedSubjectCleanupIds = vi
    .fn<(cursor: number, limit: number) => Promise<{ id: string; providerId: number }[]>>()
    .mockResolvedValue([]);
  const resumeAcceptedSubjectCleanup = vi
    .fn<(id: string, generation: string) => Promise<UnfollowedSubjectResult>>()
    .mockResolvedValue('stale');
  const reasons = createArchiveReasons({
    clock,
    archive: {
      listSubjects,
      accountActivation,
      recordVerifiedUnfollowed,
      ...(blockedCleanup ? { acceptedSubjectCleanupIds, resumeAcceptedSubjectCleanup } : {}),
    },
    account: () => account,
    subscribeAccount: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    now: () => now,
    transportSignal: () => transport.signal,
    openProbe,
    onUpdated,
  });
  return {
    rows,
    account,
    clock,
    reasons,
    reason: (subject: Subject) => reasons.snapshot()(subject),
    notifyAccount: () => {
      for (const listener of listeners) listener();
    },
    probe,
    openProbe,
    onUpdated,
    listSubjects,
    accountActivation,
    recordVerifiedUnfollowed,
    recordVerifiedBlocked,
    cleanupBlocked,
    acceptedSubjectCleanupIds,
    resumeAcceptedSubjectCleanup,
    unfollowBlocked,
    changeTransport() {
      transport.abort();
      transport = new AbortController();
    },
    async tick(advance = 0) {
      now += advance;
      await clock.runNow('archive-reasons');
    },
  };
}

describe('archive reason observation', () => {
  it('resumes accepted blocked cleanup without depending on another upstream response', async () => {
    await fixture(
      async ({
        rows,
        openProbe,
        tick,
        onUpdated,
        acceptedSubjectCleanupIds,
        resumeAcceptedSubjectCleanup,
      }) => {
        rows.splice(1);
        rows[0].archiveReason = 'account_disabled';
        acceptedSubjectCleanupIds.mockResolvedValue([rows[0]]);
        resumeAcceptedSubjectCleanup.mockResolvedValue('purged');
        openProbe.mockRejectedValue(new ProviderError('upstream-http', 503));
        await tick();
        expect(resumeAcceptedSubjectCleanup).toHaveBeenCalledExactlyOnceWith(
          'stripchat:1',
          'fixture-generation',
        );
        expect(openProbe).not.toHaveBeenCalled();
        expect(onUpdated).toHaveBeenCalledExactlyOnceWith(true);
      },
      true,
    );
  });

  it('resumes accepted local cleanup outside the remote batch during a site backoff', async () => {
    await fixture(
      async ({
        rows,
        tick,
        openProbe,
        onUpdated,
        acceptedSubjectCleanupIds,
        resumeAcceptedSubjectCleanup,
      }) => {
        rows.push(row(4), row(5), row(6));
        rows.at(-1)!.archiveReason = 'unfollowed';
        openProbe.mockRejectedValue(new ProviderError('upstream-http', 503));
        await tick();
        expect(openProbe).toHaveBeenCalledOnce();
        acceptedSubjectCleanupIds.mockResolvedValue([rows.at(-1)!]);
        resumeAcceptedSubjectCleanup.mockResolvedValue('purged');

        await tick(5_000);
        expect(openProbe).toHaveBeenCalledOnce();
        expect(resumeAcceptedSubjectCleanup).toHaveBeenCalledExactlyOnceWith(
          'stripchat:6',
          'fixture-generation',
        );
        expect(onUpdated).toHaveBeenCalledExactlyOnceWith(true);
      },
      true,
    );
  });

  it('unfollows an empty blocked archive only when the archive authorizes the operation', async () => {
    await fixture(async ({ probe, tick, recordVerifiedBlocked, unfollowBlocked, onUpdated }) => {
      probe.mockResolvedValue('account_disabled');
      recordVerifiedBlocked.mockImplementation(async (id, _generation, removeFavorite) => {
        if (id === 'stripchat:2') return 'retained';
        await removeFavorite();
        return 'purged';
      });
      await tick();
      expect(recordVerifiedBlocked).toHaveBeenCalledTimes(2);
      expect(recordVerifiedBlocked).toHaveBeenCalledWith(
        'stripchat:1',
        'fixture-generation',
        expect.any(Function),
      );
      expect(unfollowBlocked).toHaveBeenCalledExactlyOnceWith(1, expect.any(AbortSignal));
      expect(onUpdated).toHaveBeenCalledExactlyOnceWith(true);
    }, true);
  });

  it('hands cleanup to the account queue when a new roster refresh overlaps the page check', async () => {
    await fixture(
      async ({
        rows,
        account,
        accountActivation,
        probe,
        clock,
        cleanupBlocked,
        recordVerifiedBlocked,
        unfollowBlocked,
        onUpdated,
      }) => {
        rows.splice(1);
        rows[0].archiveReason = 'account_disabled';
        let completePage!: (reason: ArchiveReason) => void;
        let finishRefresh!: () => void;
        const page = new Promise<ArchiveReason>((resolve) => (completePage = resolve));
        const refresh = new Promise<void>((resolve) => (finishRefresh = resolve));
        const queuedCleanup = cleanupBlocked.getMockImplementation()!;
        probe.mockReturnValueOnce(page);
        cleanupBlocked.mockImplementationOnce(async (...args) => {
          await refresh;
          return queuedCleanup(...args);
        });
        recordVerifiedBlocked.mockImplementation(async (_id, _generation, removeFavorite) => {
          await removeFavorite();
          return 'purged';
        });
        const checking = clock.runNow('archive-reasons');
        try {
          await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
          account.running = true;
          completePage('account_disabled');
          await vi.waitFor(() => expect(cleanupBlocked).toHaveBeenCalledOnce());
          expect(recordVerifiedBlocked).not.toHaveBeenCalled();
          expect(unfollowBlocked).not.toHaveBeenCalled();
        } finally {
          completePage('account_disabled');
          account.running = false;
          accountActivation.mockResolvedValue('next-generation');
          finishRefresh();
          await checking;
        }
        expect(recordVerifiedBlocked).toHaveBeenCalledExactlyOnceWith(
          'stripchat:1',
          'next-generation',
          expect.any(Function),
        );
        expect(unfollowBlocked).toHaveBeenCalledOnce();
        expect(onUpdated).toHaveBeenCalledExactlyOnceWith(true);
      },
      true,
    );
  });

  it('keeps legacy block labels without mutating the account and retries a failed verified removal', async () => {
    await fixture(
      async ({ rows, probe, tick, recordVerifiedBlocked, unfollowBlocked, onUpdated, reasons }) => {
        rows.splice(1);
        rows[0].archiveReason = 'account_disabled';
        await tick();
        expect(recordVerifiedBlocked).not.toHaveBeenCalled();
        expect(unfollowBlocked).not.toHaveBeenCalled();

        probe.mockResolvedValue('account_disabled');
        recordVerifiedBlocked.mockImplementation(async (_id, _generation, removeFavorite) => {
          await removeFavorite();
          return 'purged';
        });
        unfollowBlocked.mockRejectedValueOnce(new ProviderError('upstream-http', 503));
        await tick(60_000);
        expect(unfollowBlocked).toHaveBeenCalledOnce();
        expect(onUpdated).not.toHaveBeenCalled();
        expect(reasons.backgroundTask().state).toBe('retrying');

        await tick(300_000);
        expect(unfollowBlocked).toHaveBeenCalledTimes(2);
        expect(onUpdated).toHaveBeenCalledExactlyOnceWith(true);
      },
      true,
    );
  });

  it('reports only the upstream code and status when a verified blocked removal is deferred', async () => {
    await fixture(async ({ rows, cleanupBlocked, probe, tick }) => {
      rows.splice(1);
      probe.mockResolvedValue('account_disabled');
      cleanupBlocked
        .mockRejectedValueOnce(new ProviderError('cancelled'))
        .mockRejectedValueOnce(new ProviderError('upstream-http', 400));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await tick();
        expect(warn).not.toHaveBeenCalled();
        await tick(60_000);
        expect(warn).toHaveBeenCalledExactlyOnceWith(
          JSON.stringify({
            event: 'archive_blocked_unfollow_deferred',
            code: 'upstream-http',
            status: 400,
          }),
        );
      } finally {
        warn.mockRestore();
      }
    }, true);
  });

  it('records an authenticated unfollow against the current generation and reports a purge', async () => {
    await fixture(async ({ probe, tick, recordVerifiedUnfollowed, onUpdated }) => {
      probe.mockResolvedValueOnce('unfollowed').mockResolvedValueOnce('account_disabled');
      recordVerifiedUnfollowed.mockResolvedValueOnce('purged');
      await tick();
      expect(recordVerifiedUnfollowed).toHaveBeenCalledExactlyOnceWith(
        'stripchat:1',
        'fixture-generation',
      );
      expect(onUpdated).toHaveBeenCalledExactlyOnceWith(true);
    });
  });

  it('checks unfollows again after a newer account activation invalidates the cleanup', async () => {
    await fixture(
      async ({ rows, probe, tick, accountActivation, recordVerifiedUnfollowed, reason }) => {
        rows.splice(1);
        probe.mockResolvedValue('unfollowed');
        recordVerifiedUnfollowed.mockResolvedValueOnce('stale');
        await tick();
        expect(reason(rows[0])).toBeUndefined();

        accountActivation.mockResolvedValueOnce('next-generation');
        await tick(5000);
        expect(recordVerifiedUnfollowed).toHaveBeenNthCalledWith(
          2,
          'stripchat:1',
          'next-generation',
        );
        expect(reason(rows[0])).toBe('unfollowed');
      },
    );
  });

  it('shares one account session across a batch and clears relationship evidence when the account changes', async () => {
    await fixture(async ({ account, rows, openProbe, probe, tick, reason }) => {
      account.profile = { username: 'first', followingCount: 2, avatarUrl: null };
      probe.mockResolvedValueOnce('unfollowed').mockResolvedValueOnce('account_disabled');
      await tick();
      expect(openProbe).toHaveBeenCalledTimes(1);
      expect(probe).toHaveBeenCalledTimes(2);
      expect(reason(rows[0])).toBe('unfollowed');
      expect(reason(rows[1])).toBe('account_disabled');

      account.profile = { username: 'second', followingCount: 2, avatarUrl: null };
      expect(reason(rows[0])).toBeUndefined();
      await tick();
      expect(openProbe).toHaveBeenCalledTimes(2);
      expect(reason(rows[0])).toBeUndefined();
    });
  });

  it('invalidates region evidence and refuses late results after a transport change on the same site', async () => {
    await fixture(async ({ account, rows, reason, tick, probe, clock, changeTransport }) => {
      rows.splice(1);
      probe.mockResolvedValueOnce('region_restricted');
      await tick();
      expect(reason(rows[0])).toBe('region_restricted');
      changeTransport();
      expect(reason(rows[0])).toBeUndefined();

      let finish!: (value: ArchiveReason | null) => void;
      const answer = new Promise<ArchiveReason | null>((resolve) => (finish = resolve));
      probe.mockReturnValueOnce(answer);
      const pending = clock.runNow('archive-reasons');
      try {
        await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
        changeTransport();
        expect(probe.mock.calls[1][2].aborted).toBe(true);
        finish('region_restricted');
        await pending;
        expect(reason(rows[0])).toBeUndefined();
        await tick();
        expect(probe).toHaveBeenLastCalledWith(account.origin, 1, expect.any(AbortSignal));
        expect(probe).toHaveBeenCalledTimes(3);
      } finally {
        finish(null);
        await pending;
      }
    });
  });

  it('checks a bounded batch on each heartbeat without waiting for a second interval', async () => {
    await fixture(async ({ rows, reason, tick, probe }) => {
      rows.push(row(4), row(5), row(6), row(7));
      probe.mockResolvedValue('region_restricted');
      await tick();
      expect(probe.mock.calls.map(([, id]) => id)).toEqual([1, 2, 4, 5]);
      await tick(5_000);
      expect(probe.mock.calls.map(([, id]) => id)).toEqual([1, 2, 4, 5, 6, 7]);
      expect(reason(rows[5])).toBe('region_restricted');
    });
  });

  it('rechecks inconclusive responses without waiting several hours', async () => {
    await fixture(async ({ rows, reason, tick, probe }) => {
      rows.splice(1);
      probe.mockResolvedValueOnce(null).mockResolvedValueOnce('region_restricted');
      await tick();
      await tick(5_000);
      expect(probe).toHaveBeenCalledTimes(1);
      await tick(55_000);
      expect(reason(rows[0])).toBe('region_restricted');
    });
  });

  it('resumes a deferred heartbeat as soon as the roster refresh settles', async () => {
    await fixture(async ({ account, rows, tick, probe, listSubjects, notifyAccount }) => {
      listSubjects.mockImplementationOnce(() => {
        account.running = true;
        return Promise.resolve(rows);
      });
      await tick();
      expect(probe).not.toHaveBeenCalled();
      account.running = false;
      notifyAccount();
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    });
  });

  it('checks only archived subjects on the binding and publishes one update per changed batch', async () => {
    await fixture(async ({ rows, reason, tick, probe, onUpdated }) => {
      probe.mockResolvedValueOnce('region_restricted').mockResolvedValueOnce('account_disabled');
      await tick();
      expect(probe.mock.calls.map(([origin, id]) => [origin, id])).toEqual([
        ['https://stripchat.com', 1],
        ['https://stripchat.com', 2],
      ]);
      expect(reason(rows[0])).toBe('region_restricted');
      expect(reason(rows[1])).toBe('account_disabled');
      expect(reason({ ...rows[0], archived: false })).toBeUndefined();
      expect(rows[0].providerStatus).toBe('UNKNOWN');
      await tick(5000);
      expect(probe).toHaveBeenCalledTimes(2);
      expect(onUpdated).toHaveBeenCalledOnce();
    });
  });

  it('backs off a challenged route and keeps missing or inconclusive cases unclassified', async () => {
    await fixture(async ({ rows, reason, reasons, tick, probe }) => {
      rows.splice(1);
      probe.mockRejectedValueOnce(new ProviderError('upstream-http', 403, false, undefined, true));
      await tick();
      expect(reasons.backgroundTask()).toMatchObject({
        state: 'retrying',
        error: 'site_verification_required',
        nextRunAtMs: 310_000,
        consecutiveFailures: 1,
      });
      rows.push(row(2), row(4));
      await tick(60_000);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(reasons.backgroundTask().consecutiveFailures).toBe(1);
      expect(reason(rows[0])).toBeUndefined();
      probe.mockRejectedValueOnce(new ProviderError('upstream-http', 404));
      await tick(5 * 60_000);
      expect(probe.mock.calls.map(([, id]) => id)).toEqual([1, 2]);
      await tick(5000);
      expect(probe.mock.calls.map(([, id]) => id)).toEqual([1, 2, 4, 1]);
      expect(rows.map(reason)).toEqual([undefined, undefined, undefined]);
      expect(reasons.backgroundTask().consecutiveFailures).toBe(0);
    });
  });

  it('counts the stored archive reason when its fresh check is blocked', async () => {
    await fixture(async ({ rows, reasons, tick, probe }) => {
      rows[0].archiveReason = 'account_disabled';
      probe.mockRejectedValue(new ProviderError('upstream-http', 403));
      await tick();
      expect(reasons.backgroundTask()).toMatchObject({ processed: 1, total: 2 });
    });
  });

  it('requires fresh confirmation for cleanup and picks up new archives on the next heartbeat', async () => {
    await fixture(async ({ rows, reason, tick, probe, onUpdated, recordVerifiedUnfollowed }) => {
      const unfollowed: Subject = { ...rows[0], archiveReason: 'unfollowed' };
      rows.splice(0, rows.length, unfollowed);
      await tick();
      expect(probe).toHaveBeenCalledOnce();
      expect(reason(unfollowed)).toBe('unfollowed');
      expect(recordVerifiedUnfollowed).not.toHaveBeenCalled();
      expect(onUpdated).not.toHaveBeenCalled();
      rows.push(row(4));
      await tick(5000);
      expect(probe).toHaveBeenLastCalledWith('https://stripchat.com', 4, expect.any(AbortSignal));
    });
  });

  it('cleans a confirmed unfollow over a historical block while protecting region and deletion', async () => {
    await fixture(async ({ rows, reason, tick, probe, recordVerifiedUnfollowed }) => {
      rows[0].archiveReason = 'account_disabled';
      rows[1].archiveReason = 'account_deleted';
      rows.push({ ...row(4), archiveReason: 'region_restricted' });
      probe.mockResolvedValue('unfollowed');
      await tick();
      expect(recordVerifiedUnfollowed).toHaveBeenCalledExactlyOnceWith(
        'stripchat:1',
        'fixture-generation',
      );
      expect(reason(rows[1])).toBe('account_deleted');
      expect(reason(rows[3])).toBe('region_restricted');
    });
  });

  it('discards in-flight results on disconnect and expires results across bindings and time', async () => {
    await fixture(async ({ account, rows, reason, clock, tick, probe }) => {
      rows.splice(1);
      let complete!: (value: ArchiveReason) => void;
      probe.mockImplementationOnce(() => new Promise((resolve) => (complete = resolve)));
      const pending = clock.runNow('archive-reasons');
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
      account.connected = false;
      expect(reason(rows[0])).toBeUndefined();
      expect(probe.mock.calls[0][2].aborted).toBe(true);
      complete('region_restricted');
      await pending;
      account.connected = true;
      account.origin = 'https://stripchat.org';
      expect(reason(rows[0])).toBeUndefined();
      probe.mockResolvedValueOnce('account_deleted');
      await tick(10_000);
      expect(probe).toHaveBeenLastCalledWith('https://stripchat.org', 1, expect.any(AbortSignal));
      expect(reason(rows[0])).toBe('account_deleted');
      probe.mockResolvedValue(null);
      await tick(6 * 60 * 60_000);
      expect(reason(rows[0])).toBeUndefined();
    });
  });
});
