import type * as React from 'react';
import { expect, it, vi } from 'vitest';
import { UnfollowButton } from './UnfollowButton';

const { stateUpdate } = vi.hoisted(() => ({ stateUpdate: vi.fn() }));

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  useRef: <T,>(current: T) => ({ current }),
  useState: <T,>(value: T) => [value, stateUpdate],
}));

interface ButtonEvent {
  stopPropagation(): void;
}
interface ButtonActions {
  onPointerDown(event: ButtonEvent): void;
  onClick(event: ButtonEvent): void;
}

function actions(onUnfollow: () => Promise<void>) {
  const root = UnfollowButton({ handle: 'fixture', onUnfollow }) as React.ReactElement<{
    children: React.ReactElement<ButtonActions>[];
  }>;
  return root.props.children[0].props;
}

it('keeps a rapid duplicate request local while one unfollow is pending', async () => {
  stateUpdate.mockClear();
  let complete!: () => void;
  const request = new Promise<void>((resolve) => (complete = resolve));
  const onUnfollow = vi.fn(() => request);
  const button = actions(onUnfollow);
  const pointer = { stopPropagation: vi.fn() },
    click = { stopPropagation: vi.fn() };
  button.onPointerDown(pointer);
  button.onClick(click);
  button.onClick(click);
  expect(pointer.stopPropagation).toHaveBeenCalledOnce();
  expect(click.stopPropagation).toHaveBeenCalledTimes(2);
  expect(onUnfollow).toHaveBeenCalledOnce();
  expect(stateUpdate).toHaveBeenCalledWith(true);
  complete();
  await request;
  expect(stateUpdate).toHaveBeenLastCalledWith(false);
});

it('shows the request error and permits trying the same button again', async () => {
  stateUpdate.mockClear();
  const onUnfollow = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error('取关请求失败'))
    .mockResolvedValueOnce(undefined);
  const button = actions(onUnfollow);
  const event = { stopPropagation: vi.fn() };
  button.onClick(event);
  await expect(onUnfollow.mock.results[0].value).rejects.toThrow('取关请求失败');
  expect(stateUpdate).toHaveBeenCalledWith('取关请求失败');
  button.onClick(event);
  expect(onUnfollow).toHaveBeenCalledTimes(2);
});
