import type { DocumentTransform } from './types';

export class DocumentTransformRegistry {
  private readonly transforms = new Map<string, DocumentTransform>();

  constructor(transforms: readonly DocumentTransform[] = []) {
    for (const transform of transforms) this.register(transform);
  }

  register(transform: DocumentTransform): void {
    if (this.transforms.has(transform.id)) {
      throw new Error(`Document transform "${transform.id}" is already registered`);
    }
    this.transforms.set(transform.id, transform);
  }

  get(id: string): DocumentTransform | undefined {
    return this.transforms.get(id);
  }

  require(id: string): DocumentTransform {
    const transform = this.get(id);
    if (!transform) throw new Error(`Unknown document transform: ${id}`);
    return transform;
  }

  list(): DocumentTransform[] {
    return Array.from(this.transforms.values());
  }
}
