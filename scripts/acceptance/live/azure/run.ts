import { main } from "../dns/cli";
void main("azure").then((code) => { process.exitCode = code; });
