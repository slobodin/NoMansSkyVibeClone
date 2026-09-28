/**
 * Web Worker entry point: receives a ChunkJob, builds the chunk's vertex data, posts it back.
 *
 * Workers keep the expensive noise evaluation (tens of thousands of samples per chunk) off the
 * main thread, so the frame rate does not drop while terrain streams in. The result's typed
 * arrays are *transferred*, not copied: ownership of the memory moves to the main thread.
 */
import { buildChunk, type ChunkJob } from './chunkBuilder';
import { TerrainGenerator } from './TerrainGenerator';

const generators = new Map<string, TerrainGenerator>();

self.onmessage = (event: MessageEvent<ChunkJob>) => {
  const job = event.data;
  let generator = generators.get(job.planet.name);
  if (!generator) {
    generator = new TerrainGenerator(job.planet);
    generators.set(job.planet.name, generator);
  }
  const data = buildChunk(generator, job);
  self.postMessage(data, { transfer: [data.positions.buffer, data.normals.buffer, data.surface.buffer] });
};
