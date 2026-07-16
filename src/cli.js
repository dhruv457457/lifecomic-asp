import fs from "fs-extra";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { createComic } from "./comic.js";

const argv = yargs(hideBin(process.argv))
  .option("input", {
    alias: "i",
    describe: "Path to a LifeComic JSON request",
    type: "string",
    demandOption: true
  })
  .option("out", {
    alias: "o",
    describe: "Output directory",
    type: "string",
    default: "output/comic"
  })
  .strict()
  .parseSync();

const request = await fs.readJson(argv.input);
const result = await createComic(request, { outputDir: argv.out });

console.log(JSON.stringify(result, null, 2));

