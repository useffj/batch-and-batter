// Synthetic preview only. No network, browser storage, or persistence contract.
export const MEDIA_LIMIT = 6;
export const FILE_LIMIT = 8 * 1024 * 1024;
export type PreviewImage = {
  id: string;
  url: string;
  name: string;
  alt: string;
  width: number;
  height: number;
};
export type ImageRuntime = {
  decode: (
    file: File,
  ) => Promise<{ width: number; height: number; close: () => void }>;
  create: (file: File) => string;
  revoke: (url: string) => void;
};
const allowed = ['image/jpeg', 'image/png', 'image/webp'];
export async function inspectImage(file: File, runtime: ImageRuntime) {
  if (!allowed.includes(file.type))
    throw Error(
      'Choose a JPEG, PNG or WebP image. SVG, GIF and other formats are not supported.',
    );
  if (!file.size) throw Error('This file is empty. Choose a valid image.');
  if (file.size > FILE_LIMIT)
    throw Error('Choose an image no larger than 8 MiB.');
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const signature =
    file.type === 'image/png'
      ? [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => b[i] === n)
      : file.type === 'image/jpeg'
        ? b[0] === 255 && b[1] === 216 && b[2] === 255
        : String.fromCharCode(...b.slice(0, 4)) === 'RIFF' &&
          String.fromCharCode(...b.slice(8, 12)) === 'WEBP';
  if (!signature) throw Error('The image contents do not match its file type.');
  let image;
  try {
    image = await runtime.decode(file);
  } catch {
    throw Error('This image could not be opened. Choose a different file.');
  }
  try {
    const { width, height } = image;
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 8000 ||
      height > 8000 ||
      width * height > 20000000
    )
      throw Error(
        'Choose an image up to 8,000 pixels per side and 20 megapixels.',
      );
    return { width, height };
  } finally {
    image.close();
  }
}
const empty: readonly PreviewImage[] = [];
export class PreviewMediaStore {
  private records = new Map<string, readonly PreviewImage[]>();
  private listeners = new Set<() => void>();
  private disposed = false;
  private serial = 0;
  constructor(private runtime: ImageRuntime) {}
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  get = (productId: string): readonly PreviewImage[] =>
    this.records.get(productId) ?? empty;
  private update(productId: string, images: readonly PreviewImage[]) {
    if (this.disposed) throw Error('Preview closed. Reload to begin again.');
    this.records.set(productId, images);
    this.listeners.forEach((fn) => fn());
  }
  async select(productId: string, files: File[], replaceId?: string) {
    if (this.disposed) throw Error('Preview closed.');
    const before = this.get(productId);
    if (!files.length) return;
    if (
      replaceId &&
      (files.length !== 1 || !before.some((i) => i.id === replaceId))
    )
      throw Error('Choose one replacement for an existing image.');
    if (!replaceId && before.length + files.length > MEDIA_LIMIT)
      throw Error(
        'Keep up to six images per cookie. Remove an image before adding more.',
      );
    const staged: PreviewImage[] = [];
    let accepted = false;
    try {
      for (const file of files) {
        const dimensions = await inspectImage(file, this.runtime);
        if (this.disposed) throw Error('Preview closed.');
        staged.push({
          id: 'preview-' + ++this.serial,
          name: file.name,
          alt: '',
          url: this.runtime.create(file),
          ...dimensions,
        });
      }
      if (this.disposed || this.get(productId) !== before)
        throw Error(
          'Images changed while reading files. Choose the files again.',
        );
      if (replaceId) {
        const old = before.find((i) => i.id === replaceId)!;
        this.update(
          productId,
          before.map((i) =>
            i.id === replaceId ? { ...staged[0], id: old.id, alt: old.alt } : i,
          ),
        );
        this.runtime.revoke(old.url);
      } else this.update(productId, [...before, ...staged]);
      accepted = true;
    } finally {
      if (!accepted) staged.forEach((i) => this.runtime.revoke(i.url));
    }
  }
  alt(productId: string, id: string, value: string) {
    this.update(
      productId,
      this.get(productId).map((i) =>
        i.id === id ? { ...i, alt: value.slice(0, 250) } : i,
      ),
    );
  }
  move(productId: string, id: string, to: number) {
    const items = [...this.get(productId)],
      from = items.findIndex((i) => i.id === id);
    if (from < 0 || to < 0 || to >= items.length) return;
    items.splice(to, 0, items.splice(from, 1)[0]);
    this.update(productId, items);
  }
  remove(productId: string, id: string) {
    const old = this.get(productId).find((i) => i.id === id);
    this.update(
      productId,
      this.get(productId).filter((i) => i.id !== id),
    );
    if (old) this.runtime.revoke(old.url);
  }
  dispose() {
    this.disposed = true;
    this.records.forEach((items) =>
      items.forEach((i) => this.runtime.revoke(i.url)),
    );
    this.records.clear();
    this.listeners.clear();
  }
}
