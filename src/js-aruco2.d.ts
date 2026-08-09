declare module "js-aruco2" {
  interface MarkerCorner {
    readonly x: number;
    readonly y: number;
  }

  interface Marker {
    readonly id: number;
    readonly corners: readonly MarkerCorner[];
    readonly hammingDistance: number;
  }

  interface ImageDataLike {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray;
  }

  interface Dictionary {
    readonly codeList: readonly string[];
    readonly markSize: number;
  }

  type DictionaryConstructor = new (dictionaryName: string) => Dictionary;

  interface Detector {
    detect(image: ImageDataLike): readonly Marker[];
    detectImage(
      width: number,
      height: number,
      data: Uint8ClampedArray,
    ): readonly Marker[];
  }

  type DetectorConstructor = new (configuration?: {
    readonly dictionaryName?: string;
    readonly maxHammingDistance?: number;
  }) => Detector;

  export const AR: {
    readonly Dictionary: DictionaryConstructor;
    readonly Detector: DetectorConstructor;
  };

  const aruco: { readonly AR: typeof AR };

  export default aruco;
}

declare module "js-aruco2/src/dictionaries/apriltag_36h11.js";
