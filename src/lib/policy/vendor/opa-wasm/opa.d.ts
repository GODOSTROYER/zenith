/**
 * LoadedPolicy is a wrapper around a WebAssembly.Instance and WebAssembly.Memory
 * for a compiled Rego policy. There are helpers to run the wasm instance and
 * handle the output from the policy wasm.
 */
export class LoadedPolicy {
    /**
     * Loads and initializes a compiled Rego policy.
     * @param {WebAssembly.WebAssemblyInstantiatedSource} policy
     * @param {WebAssembly.Memory} memory
     */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Preserve the licensed upstream declaration ABI.
    constructor(policy: WebAssembly.WebAssemblyInstantiatedSource, memory: WebAssembly.Memory, minorVersion: any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Preserve the licensed upstream declaration ABI.
    minorVersion: any;
    mem: WebAssembly.Memory;
    wasmInstance: WebAssembly.Instance | WebAssembly.WebAssemblyInstantiatedSource;
    dataAddr: number;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Preserve the licensed upstream declaration ABI.
    baseHeapPtr: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Preserve the licensed upstream declaration ABI.
    dataHeapPtr: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Preserve the licensed upstream declaration ABI.
    entrypoints: any;
    /**
     * Evaluates the loaded policy with the given input and
     * return the result set. This should be re-used for multiple evaluations
     * of the same policy with different inputs.
     *
     * To call a non-default entrypoint in your WASM specify it as the second
     * param. A list of entrypoints can be accessed with the `this.entrypoints`
     * property.
     * @param {any | ArrayBuffer} input input to be evaluated in form of `object`, literal primitive or ArrayBuffer (last is assumed to be a well-formed stringified JSON)
     * @param {number | string} entrypoint ID or name of the entrypoint to call (optional)
     */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Preserve the licensed upstream declaration ABI.
    evaluate(input: any | ArrayBuffer, entrypoint?: number | string): any;
    /**
     * evalBool will evaluate the policy and return a boolean answer
     * depending on the return code from the policy evaluation.
     * @deprecated Use `evaluate` instead.
     * @param {object} input
     */
    evalBool(input: object): boolean;
    /**
     * Loads data for use in subsequent evaluations.
     * @param {object | ArrayBuffer} data  data in form of `object` or ArrayBuffer (last is assumed to be a well-formed stringified JSON)
     */
    setData(data: object | ArrayBuffer): void;
}
/**
 * Takes in either an ArrayBuffer or WebAssembly.Module
 * and will return a Promise of a LoadedPolicy object which
 * can be used to evaluate the policy.
 *
 * To set custom memory size specify number of memory pages
 * as second param.
 * Defaults to 5 pages (320KB).
 * @param {BufferSource | WebAssembly.Module | Response | Promise<Response>} regoWasm
 * @param {number | WebAssembly.MemoryDescriptor} memoryDescriptor For backwards-compatibility, a 'number' argument is taken to be the initial memory size.
 * @param {{ [builtinName: string]: Function }} customBuiltins A map from string names to builtin functions
 * @returns {Promise<LoadedPolicy>}
 */
export declare function loadPolicy(regoWasm: BufferSource | WebAssembly.Module | Response | Promise<Response>, memoryDescriptor?: number | WebAssembly.MemoryDescriptor, customBuiltins?: {
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- Preserve the licensed upstream declaration ABI.
    [builtinName: string]: Function;
}): Promise<LoadedPolicy>;
/**
 * Takes in either an ArrayBuffer or WebAssembly.Module
 * and will return a LoadedPolicy object which can be
 * used to evaluate the policy.
 *
 * This cannot be used from the main thread in a browser.
 * You must use the `loadPolicy` function instead, or call
 * from a worker thread.
 *
 * To set custom memory size specify number of memory pages
 * as second param.
 * Defaults to 5 pages (320KB).
 * @param {BufferSource | WebAssembly.Module} regoWasm
 * @param {number | WebAssembly.MemoryDescriptor} memoryDescriptor For backwards-compatibility, a 'number' argument is taken to be the initial memory size.
 * @param {{ [builtinName: string]: Function }} customBuiltins A map from string names to builtin functions
 * @returns {LoadedPolicy}
 */
export declare function loadPolicySync(regoWasm: BufferSource | WebAssembly.Module, memoryDescriptor?: number | WebAssembly.MemoryDescriptor, customBuiltins?: {
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- Preserve the licensed upstream declaration ABI.
    [builtinName: string]: Function;
}): LoadedPolicy;
