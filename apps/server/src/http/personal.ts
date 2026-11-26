import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ArchivePort } from '../ports.js';
import { archiveWindows } from '../archive/calendar-window.js';

const subject = z
  .string()
  .regex(/^stripchat:[1-9]\d*$/)
  .refine((value) => Number.isSafeInteger(Number(value.slice(10))));
const uuid = z
  .string()
  .uuid()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const query = z
  .object({
    subjectId: subject,
    from: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    to: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/** Parent scope authenticates all routes; no client-supplied user identity is accepted. */
export function registerPersonal(app: FastifyInstance, archive: ArchivePort): void {
  app.get('/api/me/favorites', async (request) => {
    const input = query.parse(request.query);
    await archiveWindows(archive, input.from, input.to);
    return archive.personal(input.subjectId, input.from, input.to);
  });
  app.delete('/api/me/favorites/:id', async (request, reply) => {
    await archive.removeFavorite(uuid.parse((request.params as { id: string }).id));
    return reply.code(204).send();
  });
  app.addHook('onSend', (request, reply, _payload, done) => {
    if (request.url.startsWith('/api/me/')) reply.header('cache-control', 'private, no-store');
    done();
  });
}
