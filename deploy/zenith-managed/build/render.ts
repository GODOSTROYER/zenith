import { readFileSync } from "node:fs";
import { validateConfig, renderBaseline, renderProxy } from "../../../src/lib/providers/kubernetes/build/index";
const config=validateConfig(JSON.parse(readFileSync(process.argv[2],"utf8")));
process.stdout.write(JSON.stringify({apiVersion:"v1",kind:"List",items:[...renderBaseline(config),...renderProxy(config)]}));

