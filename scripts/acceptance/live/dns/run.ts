import { Provider } from "./contracts";
import { main } from "./cli";
const provider = Provider.safeParse(process.argv[2]);
if (!provider.success) { process.stderr.write("DNS acceptance needs azure, gcp or oci\n"); process.exitCode = 2; }
else void main(provider.data, process.argv.slice(3), process.env, true).then((code) => { process.exitCode = code; });
