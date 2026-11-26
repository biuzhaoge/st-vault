import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ArchivePort } from '../ports.js';
import {
  archiveWindows,
  WORKBENCH_WINDOW_MS,
  type CalendarArchive,
} from '../archive/calendar-window.js';

type EventsArchive = Pick<ArchivePort, 'events' | 'eventMeta' | 'ackEvents' | 'runHistory'> &
  CalendarArchive;
const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Requires the app's normal authenticated API hook; never accepts event creation from HTTP. */
export function registerEvents(app: FastifyInstance, archive: EventsArchive): void {
  app.get('/api/events/meta', (_request, reply) => {
    reply.header('cache-control', 'private, no-store');
    return archive.eventMeta();
  });
  app.get('/api/events/runs', async (request, reply) => {
    const query = z
      .object({
        from: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        to: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .parse(request.query);
    await archiveWindows(archive, query.from, query.to, WORKBENCH_WINDOW_MS);
    reply.header('cache-control', 'private, no-store');
    return archive.runHistory(query.from, query.to);
  });
  app.get('/api/events', async (request, reply) => {
    const query = z
      .object({
        after: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
        before: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .strict()
      .refine((value) => value.after === undefined || value.before === undefined)
      .parse(request.query);
    reply.header('cache-control', 'private, no-store');
    return archive.events(query);
  });
  app.post('/api/events/read', async (request, reply) => {
    const body = z.object({ cursor }).strict().parse(request.body);
    reply.header('cache-control', 'private, no-store');
    try {
      return await archive.ackEvents(body.cursor);
    } catch (error) {
      if (error instanceof Error && error.message === 'INVALID_EVENT_CURSOR')
        return reply.code(400).send({ error: 'invalid_event_cursor' });
      throw error;
    }
  });
}
