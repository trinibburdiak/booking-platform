import type { INestApplication } from '@nestjs/common';

/**
 * Bull Board en /admin/queues del puerto del servicio, para ver jobs pendientes,
 * diferidos y fallidos. Solo fuera de producción: no pasa por el gateway ni tiene login.
 * Recibe las colas de BullMQ del servicio.
 */
export async function mountQueuesBoard(app: INestApplication, queues: unknown[]) {
  if (process.env.NODE_ENV === 'production') return;
  const { createBullBoard } = await import('@bull-board/api');
  const { BullMQAdapter } = await import('@bull-board/api/bullMQAdapter');
  const { ExpressAdapter } = await import('@bull-board/express');
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/admin/queues');
  createBullBoard({ queues: queues.map((q) => new BullMQAdapter(q as never)), serverAdapter });
  app.use('/admin/queues', serverAdapter.getRouter());
}
