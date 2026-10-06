// eslint-disable-next-line @typescript-eslint/no-require-imports -- Preserve the licensed upstream CommonJS ABI.
const json = require("./json");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Preserve the licensed upstream CommonJS ABI.
const strings = require("./strings");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Preserve the licensed upstream CommonJS ABI.
const regex = require("./regex");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Preserve the licensed upstream CommonJS ABI.
const yaml = require("./yaml");

module.exports = {
  ...json,
  ...strings,
  ...regex,
  ...yaml,
};
