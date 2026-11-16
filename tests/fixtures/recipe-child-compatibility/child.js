// A small real Node child for the worker compatibility fixture. The parent
// test controls its lifetime through stdin and proves settlement from close.
process.stdin.resume();
process.stdin.once("data", () => process.exit(0));
process.stdin.once("end", () => process.exit(0));
