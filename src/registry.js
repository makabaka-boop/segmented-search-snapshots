export class SegmentRefs {
  constructor(registry, segmentIds = []) {
    this.registry = registry;
    this.ids = new Set(segmentIds);
    this.released = false;
    for (const id of this.ids) registry.acquire(id);
  }

  add(id) {
    if (!this.ids.has(id)) {
      this.ids.add(id);
      this.registry.acquire(id);
    }
  }

  release() {
    if (this.released) return;
    this.released = true;
    for (const id of this.ids) this.registry.release(id);
    this.ids.clear();
  }
}

export class SegmentRegistry {
  constructor(segments = new Map()) {
    this.segments = segments;
    this.refCounts = new Map([...segments.keys()].map((id) => [id, 0]));
  }

  setPublished(segments) {
    this.segments = segments;
    for (const id of segments.keys()) {
      if (!this.refCounts.has(id)) this.refCounts.set(id, 0);
    }
  }

  has(id) {
    return this.segments.has(id);
  }

  get(id) {
    return this.segments.get(id);
  }

  acquire(id) {
    const current = this.refCounts.get(id) || 0;
    this.refCounts.set(id, current + 1);
  }

  release(id) {
    const current = this.refCounts.get(id);
    if (current === undefined) return;
    if (current <= 1) this.refCounts.delete(id);
    else this.refCounts.set(id, current - 1);
  }

  isReferenced(id) {
    return (this.refCounts.get(id) || 0) > 0;
  }

  unreferenced(candidateIds) {
    return candidateIds.filter((id) => !this.isReferenced(id));
  }
}
