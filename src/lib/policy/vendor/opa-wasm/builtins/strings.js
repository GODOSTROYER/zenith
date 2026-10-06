// eslint-disable-next-line @typescript-eslint/no-require-imports -- Preserve the licensed upstream CommonJS ABI.
const vsprintf = require("./sprintf").vsprintf;

const sprintf = (s, values) => vsprintf(s, values);

module.exports = { sprintf };
