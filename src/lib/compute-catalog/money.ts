/** Exact nonnegative decimal arithmetic for compute quotes. No binary float billing totals. */
interface Decimal {
  coefficient: bigint;
  scale: number;
}

function parse(value: string): Decimal {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) || value.length > 512) {
    throw new Error("Money must be a bounded nonnegative decimal string.");
  }
  const [whole, fraction = ""] = value.split(".");
  return { coefficient: BigInt(whole! + fraction), scale: fraction.length };
}

function format(value: Decimal): string {
  if (value.coefficient === 0n) return "0";
  const digits = value.coefficient.toString().padStart(value.scale + 1, "0");
  if (value.scale === 0) return digits;
  return `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`.replace(/0+$/, "").replace(/\.$/, "");
}

/** Expand scientific notation from a validated finite JS quantity before exact multiplication. */
export function decimalFromNumber(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error("Quantity must be finite and nonnegative.");
  const text = value.toString();
  if (!text.includes("e")) return text;
  const [mantissa, exponentText] = text.split("e");
  const [whole, fraction = ""] = mantissa!.split(".");
  const exponent = Number(exponentText);
  const scale = fraction.length - exponent;
  const coefficient = BigInt(whole! + fraction);
  return format(scale < 0 ? { coefficient: coefficient * 10n ** BigInt(-scale), scale: 0 } : { coefficient, scale });
}

/** Multiply the exact rate by the requested hour quantity and instance count. */
export function computePeriodUsd(hourlyUsd: string, hours: number, instances: number): string {
  if (!Number.isSafeInteger(instances) || instances < 1) throw new Error("Instance count must be a positive safe integer.");
  const price = parse(hourlyUsd);
  const quantity = parse(decimalFromNumber(hours));
  return format({ coefficient: price.coefficient * quantity.coefficient * BigInt(instances), scale: price.scale + quantity.scale });
}

export function compareUsd(a: string, b: string): number {
  const left = parse(a);
  const right = parse(b);
  const scale = Math.max(left.scale, right.scale);
  const x = left.coefficient * 10n ** BigInt(scale - left.scale);
  const y = right.coefficient * 10n ** BigInt(scale - right.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Floating point is used only for dimensionless preference scores, never stored monetary totals. */
export function usdForScore(value: string): number {
  parse(value);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("Price is outside the supported scoring range.");
  return number;
}
