export class DecodeError extends Error {
  readonly path: string;

  constructor(path: string, expected: string) {
    super(`${path} must be ${expected}.`);
    this.name = "DecodeError";
    this.path = path;
  }
}

export interface Decoder<T> {
  decode(value: unknown, path?: string): T;
}

interface OptionalDecoder<T> extends Decoder<T | undefined> {
  readonly optional: true;
}

type Decoded<T> = T extends Decoder<infer Value> ? Value : never;
type Shape = Readonly<Record<string, Decoder<unknown>>>;
type OptionalKeys<ObjectShape extends Shape> = {
  [Key in keyof ObjectShape]: ObjectShape[Key] extends OptionalDecoder<unknown>
    ? Key
    : never;
}[keyof ObjectShape];
type RequiredKeys<ObjectShape extends Shape> = Exclude<
  keyof ObjectShape,
  OptionalKeys<ObjectShape>
>;
type DecodedObject<ObjectShape extends Shape> = {
  readonly [Key in RequiredKeys<ObjectShape>]: Decoded<ObjectShape[Key]>;
} & {
  readonly [Key in OptionalKeys<ObjectShape>]?: Exclude<
    Decoded<ObjectShape[Key]>,
    undefined
  >;
};

function decoder<T>(
  operation: (value: unknown, path: string) => T,
): Decoder<T> {
  return {
    decode: (value, path = "response") => operation(value, path),
  };
}

export const text = decoder<string>((value, path) => {
  if (typeof value !== "string") throw new DecodeError(path, "text");
  return value;
});

export const boolean = decoder<boolean>((value, path) => {
  if (typeof value !== "boolean") throw new DecodeError(path, "a boolean");
  return value;
});

export const number = decoder<number>((value, path) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DecodeError(path, "a finite number");
  }
  return value;
});

export const integer = decoder<number>((value, path) => {
  if (!Number.isInteger(value)) throw new DecodeError(path, "an integer");
  return Number(value);
});

export const nonNegativeInteger = decoder<number>((value, path) => {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new DecodeError(path, "a non-negative integer");
  }
  return Number(value);
});

export const isoDateTime = decoder<string>((value, path) => {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new DecodeError(path, "a valid date and time");
  }
  return value;
});

export const calendarDate = decoder<string>((value, path) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new DecodeError(path, "a calendar date");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new DecodeError(path, "a calendar date");
  }
  return value;
});

export function literal<const Value extends string | number | boolean | null>(
  expected: Value,
): Decoder<Value> {
  return decoder((value, path) => {
    if (value !== expected) {
      throw new DecodeError(path, JSON.stringify(expected));
    }
    return expected;
  });
}

export function enumeration<const Values extends readonly string[]>(
  ...values: Values
): Decoder<Values[number]> {
  const accepted = new Set<string>(values);
  return decoder((value, path) => {
    if (typeof value !== "string" || !accepted.has(value)) {
      throw new DecodeError(path, `one of ${values.join(", ")}`);
    }
    return value;
  });
}

export function optional<T>(valueDecoder: Decoder<T>): OptionalDecoder<T> {
  return {
    optional: true,
    decode: (value, path = "response") =>
      value === undefined ? undefined : valueDecoder.decode(value, path),
  };
}

export function nullable<T>(valueDecoder: Decoder<T>): Decoder<T | null> {
  return decoder((value, path) =>
    value === null ? null : valueDecoder.decode(value, path),
  );
}

export function array<T>(itemDecoder: Decoder<T>): Decoder<readonly T[]> {
  return decoder((value, path) => {
    if (!Array.isArray(value)) throw new DecodeError(path, "an array");
    return value.map((item, index) =>
      itemDecoder.decode(item, `${path}[${String(index)}]`),
    );
  });
}

export function object<const ObjectShape extends Shape>(
  shape: ObjectShape,
): Decoder<DecodedObject<ObjectShape>> {
  return decoder((value, path) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new DecodeError(path, "an object");
    }
    const source = value as Readonly<Record<string, unknown>>;
    const result: Record<string, unknown> = {};
    for (const [key, valueDecoder] of Object.entries(shape)) {
      const decoded = valueDecoder.decode(source[key], `${path}.${key}`);
      if (decoded !== undefined || source[key] !== undefined) {
        result[key] = decoded;
      }
    }
    return result as DecodedObject<ObjectShape>;
  });
}

export function union<const Decoders extends readonly Decoder<unknown>[]>(
  ...decoders: Decoders
): Decoder<Decoded<Decoders[number]>> {
  return decoder((value, path) => {
    let mostSpecificError: DecodeError | undefined;
    for (const valueDecoder of decoders) {
      try {
        return valueDecoder.decode(value, path) as Decoded<Decoders[number]>;
      } catch (error) {
        if (!(error instanceof DecodeError)) throw error;
        if (
          mostSpecificError === undefined ||
          error.path.length > mostSpecificError.path.length
        ) {
          mostSpecificError = error;
        }
      }
    }
    if (mostSpecificError !== undefined && mostSpecificError.path !== path) {
      throw mostSpecificError;
    }
    throw new DecodeError(path, "a supported response variant");
  });
}

export function keyedRecord<const Keys extends readonly string[], Value>(
  keys: Keys,
  valueDecoder: Decoder<Value>,
): Decoder<Readonly<Record<Keys[number], Value>>> {
  return decoder((value, path) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new DecodeError(path, "an object");
    }
    const source = value as Readonly<Record<string, unknown>>;
    const result: Record<string, Value> = {};
    for (const key of keys) {
      result[key] = valueDecoder.decode(source[key], `${path}.${key}`);
    }
    return result as Readonly<Record<Keys[number], Value>>;
  });
}

export function valueRecord<Value>(
  valueDecoder: Decoder<Value>,
): Decoder<Readonly<Record<string, Value>>> {
  return decoder((value, path) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new DecodeError(path, "an object");
    }
    const result: Record<string, Value> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = valueDecoder.decode(item, path + "." + key);
    }
    return result;
  });
}

export const discard = decoder<undefined>(() => undefined);
