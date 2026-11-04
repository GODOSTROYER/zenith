/**
 * A small builder for `TofuFragment`s.
 *
 * It guarantees what every AWS driver's compile must: each tofu address
 * defined once (a duplicate label inside one node is a driver bug, caught here
 * with the node's address instead of later by the workspace assembler), the
 * PRIMARY resource first in `addresses` (see refs.ts), attributes published for
 * other nodes as locals, and insertion-independent output (`build()` returns
 * key-sorted maps; `addresses` keep insertion order on purpose — primary first).
 *
 * Resource bodies are plain JSON in tofu `.tf.json` shape: nested blocks are
 * arrays of objects, references are `${…}` strings.
 */
import type { TofuFragment } from "@/lib/drivers/types";
import { DriverCompileError } from "./errors";
import { refExpr, refLocalName } from "./refs";

type Body = Record<string, unknown>;

function sortedObject<T>(m: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export class FragmentBuilder {
  private readonly resources: Record<string, Record<string, Body>> = {};
  private readonly datas: Record<string, Record<string, Body>> = {};
  private readonly outputs: NonNullable<TofuFragment["output"]> = {};
  private readonly localVars: Record<string, unknown> = {};
  private readonly order: string[] = [];

  /** @param nodeAddress the node this fragment belongs to (error messages only) */
  constructor(readonly nodeAddress: string) {}

  /** Seed a builder from an existing fragment, e.g. to add a security group to another driver's output. */
  static from(nodeAddress: string, fragment: TofuFragment): FragmentBuilder {
    const b = new FragmentBuilder(nodeAddress);
    for (const a of fragment.addresses) b.order.push(a);
    for (const [t, named] of Object.entries(fragment.resource ?? {})) for (const [n, body] of Object.entries(named)) (b.resources[t] ??= {})[n] = body;
    for (const [t, named] of Object.entries(fragment.data ?? {})) for (const [n, body] of Object.entries(named)) (b.datas[t] ??= {})[n] = body;
    Object.assign(b.outputs, fragment.output ?? {});
    Object.assign(b.localVars, fragment.locals ?? {});
    return b;
  }

  private claim(tofuAddress: string): void {
    if (this.order.includes(tofuAddress)) throw new DriverCompileError("invalid_spec", this.nodeAddress, `tofu address ${tofuAddress} is defined twice.`);
    this.order.push(tofuAddress);
  }

  /** Define a resource; returns its tofu address (`aws_vpc.network_main`). */
  resource(type: string, label: string, body: Body): string {
    const address = `${type}.${label}`;
    this.claim(address);
    (this.resources[type] ??= {})[label] = body;
    return address;
  }

  /** Define a data source; returns its tofu address (`data.aws_route53_zone.zone`). */
  data(type: string, label: string, body: Body): string {
    const address = `data.${type}.${label}`;
    this.claim(address);
    (this.datas[type] ??= {})[label] = body;
    return address;
  }

  output(name: string, value: unknown, opts: { sensitive?: boolean; description?: string } = {}): void {
    if (name in this.outputs) throw new DriverCompileError("invalid_spec", this.nodeAddress, `output ${name} is defined twice.`);
    this.outputs[name] = { value, ...opts };
  }

  local(name: string, value: unknown): void {
    if (name in this.localVars) throw new DriverCompileError("invalid_spec", this.nodeAddress, `local ${name} is defined twice.`);
    this.localVars[name] = value;
  }

  /** Publish `attribute` of this node for other nodes' `ctx.ref` (see refs.ts). `expression` may be bare or `${…}`. */
  expose(attribute: string, expression: string): void {
    this.local(refLocalName(this.nodeAddress, attribute), refExpr(expression));
  }

  build(): TofuFragment {
    const fragment: TofuFragment = { addresses: [...this.order] };
    const sortNamed = (m: Record<string, Record<string, Body>>) => sortedObject(Object.fromEntries(Object.entries(m).map(([t, named]) => [t, sortedObject(named)])));
    if (Object.keys(this.resources).length) fragment.resource = sortNamed(this.resources);
    if (Object.keys(this.datas).length) fragment.data = sortNamed(this.datas);
    if (Object.keys(this.outputs).length) fragment.output = sortedObject(this.outputs);
    if (Object.keys(this.localVars).length) fragment.locals = sortedObject(this.localVars);
    return fragment;
  }
}
