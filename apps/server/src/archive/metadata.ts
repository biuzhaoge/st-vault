import { Worker } from 'node:worker_threads';
import { AsyncLocalStorage } from 'node:async_hooks';
import { addAbortListener } from 'node:events';
import { transferableAbortController } from 'node:util';
import { metadataLane, metadataStatementReads, type MetadataLane } from './metadata-policy.js';
import { logContext } from '../runtime/runtime-logs.js';
interface RpcReply {
  id?: number;
  ready?: boolean;
  error?: string;
  value?: unknown;
  executionMs?: number;
  handlerMs?: number;
  barrierMs?: number;
  slowestMethod?: string;
  slowestHandlerMs?: number;
}
export class Metadata {
  private next = 1;
  private dead = false;
  private finishing = false;
  private reads = 0;
  private playbackReads = 0;
  private backgroundReads = 0;
  private readonly readContext = new AsyncLocalStorage<boolean>();
  private lastDiagnosticAt = -Infinity;
  private readonly exited: Promise<void>;
  private readonly pending = new Map<
    number,
    {
      method: string;
      started: number;
      lane: MetadataLane;
      signal?: AbortSignal;
      requestId?: string;
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
    }
  >();
  private readonly ready: Promise<void>;
  private readonly worker: Worker;
  constructor(root: string, worker?: Worker, mediaRoot?: string) {
    this.worker =
      worker ??
      new Worker(new URL('./metadata-worker.mjs', import.meta.url), {
        workerData: { root, mediaRoot },
        execArgv: [],
      });
    this.exited = new Promise((resolve) => this.worker.once('exit', () => resolve()));
    this.ready = new Promise((resolve, reject) => {
      this.worker.on('message', (reply: RpcReply) => {
        if (reply.ready !== undefined) {
          if (reply.ready) resolve();
          else {
            this.finishing = true;
            reject(new Error(reply.error ?? 'METADATA_START_FAILED'));
          }
          return;
        }
        if (reply.id === undefined) return;
        const promise = this.pending.get(reply.id);
        if (!promise) return;
        this.pending.delete(reply.id);
        if (promise.lane !== 'control') this.reads--;
        if (promise.lane === 'playback') this.playbackReads--;
        if (promise.lane === 'background') this.backgroundReads--;
        const rpcElapsedMs = performance.now() - promise.started;
        if (rpcElapsedMs >= 500)
          this.diagnose(
            'metadata_rpc_slow',
            promise.method,
            promise.requestId,
            rpcElapsedMs,
            reply,
          );
        if (promise.method === 'close' && !reply.error) this.finishing = true;
        if (reply.error === 'METADATA_READ_CANCELLED' && promise.signal?.aborted)
          promise.reject(promise.signal.reason);
        else if (reply.error) promise.reject(new Error(reply.error));
        else promise.resolve(reply.value);
      });
      const terminate = (): void => {
        this.dead = true;
        const error = new Error('METADATA_WORKER_UNAVAILABLE');
        reject(error);
        for (const p of this.pending.values()) p.reject(error);
        this.pending.clear();
        this.reads = 0;
        this.playbackReads = 0;
        this.backgroundReads = 0;
      };
      this.worker.on('error', terminate);
      this.worker.on('exit', terminate);
    });
  }
  call<T>(method: string, input: unknown = {}): Promise<T> {
    return this.request(method, input, false);
  }
  read<T>(method: string, input: unknown = {}, signal?: AbortSignal): Promise<T> {
    return this.request(method, input, true, signal);
  }
  withBackgroundReads<T>(action: () => Promise<T>): Promise<T> {
    return this.readContext.run(true, action);
  }
  private async request<T>(
    method: string,
    input: unknown,
    read: boolean,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    if (this.dead) throw new Error('METADATA_WORKER_UNAVAILABLE');
    const classified = metadataLane(method, read);
    if (signal && classified === 'control') throw new Error('METADATA_CANCELLATION_REQUIRES_READ');
    const requestId = signal ? logContext.getStore()?.requestId : undefined;
    const lane: MetadataLane =
      (classified !== 'control' || metadataStatementReads.has(method)) &&
      this.readContext.getStore()
        ? 'background'
        : classified;
    // Playback has reserved slots; read floods cannot use the control/write lane.
    if (
      (lane === 'read' && this.reads - this.playbackReads - this.backgroundReads >= 64) ||
      (lane === 'background' && this.backgroundReads >= 64) ||
      (lane === 'playback' && this.playbackReads >= 16)
    ) {
      this.diagnose('metadata_read_busy', method, requestId);
      throw new Error('METADATA_READ_BUSY');
    }
    // The bridge transfers the cancellation event, without cloning the caller's reason.
    const cancellation = signal ? transferableAbortController() : undefined;
    const forwardAbort =
      signal && cancellation && addAbortListener(signal, () => cancellation.abort());
    const id = this.next++;
    if (lane !== 'control') this.reads++;
    if (lane === 'playback') this.playbackReads++;
    if (lane === 'background') this.backgroundReads++;
    return (await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, {
        method,
        started: performance.now(),
        lane,
        signal,
        requestId,
        resolve,
        reject,
      });
      try {
        const message = {
          id,
          method,
          input,
          ...(lane === 'background' ? { backgroundRead: true } : {}),
        };
        if (cancellation)
          this.worker.postMessage({ ...message, signal: cancellation.signal, requestId }, [
            cancellation.signal,
          ]);
        else this.worker.postMessage(message);
      } catch (error) {
        this.pending.delete(id);
        if (lane !== 'control') this.reads--;
        if (lane === 'playback') this.playbackReads--;
        if (lane === 'background') this.backgroundReads--;
        reject(error instanceof Error ? error : new Error('METADATA_REQUEST_FAILED'));
      }
    }).finally(() => {
      forwardAbort?.[Symbol.dispose]();
      // The transfer owns a MessageChannel through the RPC's lifetime.
      cancellation?.abort();
    })) as T;
  }
  stats(): { pending: number; readPending: number; oldestRpcMs: number } {
    const now = performance.now();
    let oldestRpcMs = 0;
    for (const request of this.pending.values())
      oldestRpcMs = Math.max(oldestRpcMs, now - request.started);
    return { pending: this.pending.size, readPending: this.reads, oldestRpcMs };
  }
  private diagnose(
    event: string,
    method: string,
    requestId?: string,
    rpcElapsedMs?: number,
    { executionMs, handlerMs, barrierMs, slowestMethod, slowestHandlerMs }: RpcReply = {},
  ): void {
    const now = performance.now();
    if (now - this.lastDiagnosticAt < 10000) return;
    this.lastDiagnosticAt = now;
    const workerExecutionMs =
      executionMs !== undefined && Number.isFinite(executionMs) && executionMs >= 0
        ? executionMs
        : undefined;
    // The remainder includes mailbox wait, message transport and main-thread
    // scheduling. Do not label it as pure queue time or compare thread clock origins.
    const rpcNonExecutionMs =
      rpcElapsedMs !== undefined && workerExecutionMs !== undefined
        ? Math.max(0, rpcElapsedMs - workerExecutionMs)
        : undefined;
    console.warn(
      JSON.stringify({
        event,
        method,
        requestId,
        rpcElapsedMs,
        workerExecutionMs,
        workerHandlerMs: handlerMs,
        workerBarrierMs: barrierMs,
        batchSlowestMethod: slowestMethod,
        batchSlowestHandlerMs: slowestHandlerMs,
        rpcNonExecutionMs,
        ...this.stats(),
      }),
    );
  }
  async terminate(): Promise<void> {
    // After a close/failure acknowledgment the worker is already exiting. Let its
    // native SQLite/module teardown finish instead of interrupting the isolate.
    if (this.finishing || this.dead) await this.exited;
    else await this.worker.terminate();
  }
}
