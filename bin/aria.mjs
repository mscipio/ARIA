#!/usr/bin/env node
// ARIA manager entry point. Thin launcher: everything lives in src/manager/ (TypeScript, loaded
// directly; Node >= 22.18 strips types natively). `aria` alone opens the management TUI when
// stdin and stdout are terminals, and prints help otherwise.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`ARIA needs Node.js >= 22.18 (found ${process.versions.node}).`);
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = async (file) => {
  try {
    return await import(pathToFileURL(join(root, "src", "manager", file)).href);
  } catch (error) {
    const missing = /Cannot find package '([^']+)'/.exec(error.message)?.[1];
    console.error(
      missing
        ? `ARIA's CLI packages are not installed (${missing}). In a development checkout run \`npm install\`; for a release run \`aria repair\` or reinstall it.`
        : `Cannot load ARIA manager (${file}): ${error.message}`,
    );
    process.exit(2);
  }
};

const argv = process.argv.slice(2);
const interactive = process.stdin.isTTY && process.stdout.isTTY && !process.env.ARIA_NO_UI && !process.env.CI;
const wantsUi = argv[0] === "ui" || (argv.length === 0 && interactive);

if (wantsUi) {
  if (!interactive) {
    console.error("The management TUI needs an interactive terminal. Use the commands below instead.\n");
    const { USAGE } = await load("cli.ts");
    console.log(USAGE);
    process.exit(2);
  }
  const dirFlag = argv.indexOf("--dir");
  const project = dirFlag >= 0 && argv[dirFlag + 1] ? argv[dirFlag + 1] : process.cwd();
  const { runUi } = await load("ui.ts");
  process.exit(await runUi(project));
} else {
  const { main } = await load("cli.ts");
  process.exitCode = await main(argv);
}
