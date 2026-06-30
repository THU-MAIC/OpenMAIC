declare module 'utif' {
  const UTIF: {
    decode(buff: ArrayBuffer | Uint8Array): unknown[];
    decodeImage(buff: Uint8Array, img: unknown, ifds: unknown[]): void;
    toRGBA8(out: unknown): Uint8Array;
  };
  export default UTIF;
}

declare module 'pngjs' {
  export class PNG {
    width: number;
    height: number;
    data: Buffer | Uint8Array;
    constructor(options: { width: number; height: number });
    static sync: {
      write(png: PNG): Buffer | Uint8Array;
    };
  }
}

declare module 'jpegxr' {
  class JpegXR {
    constructor();
    then<T>(
      resolve: (mod: { decode(data: Uint8Array | ArrayBuffer): JpegXRResult }) => T,
    ): Promise<T>;
  }
  interface JpegXRResult {
    width: number;
    height: number;
    bytes: Uint8Array;
    pixelInfo: { channels: number; bgr: boolean; hasAlpha: boolean };
  }
  export = JpegXR;
}

declare module 'canvas' {
  export function createCanvas(
    width: number,
    height: number,
  ): {
    getContext(type: '2d'): unknown;
    toBuffer(mime: string): Buffer;
    width: number;
    height: number;
  };
}
