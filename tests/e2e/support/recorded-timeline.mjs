/** A one-pixel inset keeps real pointer drags off the column divider. */
const laneBounds = (lane) =>
  lane.evaluate((node) => {
    const from = Number(node.dataset.from);
    const to = Number(node.dataset.to);
    return { from, to, msPerPixel: (to - from) / node.getBoundingClientRect().width };
  });

export async function showRecordedTimeline(page, row, { archiveStart, archiveEnd }) {
  const lane = row.locator('.track-lane');
  await lane.waitFor();
  const initial = await laneBounds(lane);
  if (archiveStart <= initial.from + initial.msPerPixel) {
    await page.getByRole('button', { name: '前12小时', exact: true }).click();
    await row.locator(`.track-lane:not([data-from="${initial.from}"])`).waitFor();
  }
  await lane.locator('.track-clip').first().waitFor();
  // Raw pointer coordinates are valid only after the real half-day pan has settled.
  await lane
    .locator(':scope > .timeline-scene')
    .evaluate((scene) => Promise.all(scene.getAnimations().map((animation) => animation.finished)));
  const { from, to, msPerPixel } = await laneBounds(lane);
  if (archiveStart < from + msPerPixel || archiveEnd > to - msPerPixel)
    throw new Error('The complete fixture recording must fit inside the pointer selection');
  return lane;
}

export async function dragRecordedTimeline(page, lane) {
  const box = await lane.boundingBox();
  await page.mouse.move(box.x + 1, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + 40, { steps: 6 });
  await page.mouse.up();
}
