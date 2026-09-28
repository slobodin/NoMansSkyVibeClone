import type { ChunkJob, ChunkMeshData } from './chunkBuilder';

/** A queued or running chunk build. The terrain keeps the handle to update priority or cancel. */
export interface ChunkRequest {
  /** Lower = more urgent. The terrain sets it to the camera distance every frame. */
  priority: number;
  cancelled: boolean;
  readonly job: ChunkJob;
  readonly onDone: (data: ChunkMeshData) => void;
}

/**
 * A fixed set of Web Workers that build chunk meshes, fed from a priority queue.
 *
 * - `request` queues a job; nothing is sent to a worker until `dispatch`.
 * - `dispatch` (once per frame) hands the most urgent jobs to idle workers. The queue is re-sorted
 *   every time because priorities change as the camera moves.
 * - `cancel` drops a queued job, or marks a running one so its result is ignored on arrival
 *   (a worker cannot be interrupted mid-job, and it is only a few milliseconds anyway).
 */
export class ChunkWorkerPool {
  private readonly idle: Worker[] = [];
  private readonly queue: ChunkRequest[] = [];
  private readonly running = new Map<number, ChunkRequest>();
  private nextId = 1;

  constructor(workerCount: number) {
    for (let i = 0; i < workerCount; i++) {
      // Vite bundles the worker (and everything it imports) from this URL.
      const worker = new Worker(new URL('./chunk.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<ChunkMeshData>) => this.onResult(worker, event.data);
      worker.onerror = (event) => console.error('chunk worker error', event);
      this.idle.push(worker);
    }
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  get runningCount(): number {
    return this.running.size;
  }

  request(job: Omit<ChunkJob, 'id'>, priority: number, onDone: (data: ChunkMeshData) => void): ChunkRequest {
    const request: ChunkRequest = { job: { ...job, id: this.nextId++ }, priority, cancelled: false, onDone };
    this.queue.push(request);
    return request;
  }

  cancel(request: ChunkRequest): void {
    request.cancelled = true;
    const index = this.queue.indexOf(request);
    if (index >= 0) this.queue.splice(index, 1);
  }

  dispatch(): void {
    if (this.idle.length === 0 || this.queue.length === 0) return;
    this.queue.sort((a, b) => a.priority - b.priority);
    while (this.idle.length > 0 && this.queue.length > 0) {
      const request = this.queue.shift()!;
      const worker = this.idle.pop()!;
      this.running.set(request.job.id, request);
      worker.postMessage(request.job);
    }
  }

  private onResult(worker: Worker, data: ChunkMeshData): void {
    this.idle.push(worker);
    const request = this.running.get(data.id);
    this.running.delete(data.id);
    if (request && !request.cancelled) request.onDone(data);
    this.dispatch(); // keep the worker busy without waiting for the next frame
  }
}
