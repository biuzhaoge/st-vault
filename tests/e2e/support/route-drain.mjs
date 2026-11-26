// Keep Playwright's interceptor installed until each response has reached the browser.
// Removing routes while a sibling is still assembling its response can forward it upstream.
export function createRouteDrain() {
  const pending = new Set();
  let closing = false;
  return {
    route(page, pattern, handle) {
      return page.route(pattern, (route) => {
        if (closing) return route.abort('aborted');
        const work = handle(route);
        pending.add(work);
        return work.finally(() => pending.delete(work));
      });
    },
    async drain() {
      closing = true;
      await Promise.all(pending);
    },
  };
}
