/**
 * `ai-dev uninstall [--clients] [--data] [--yes] [--json]` — take the Windows
 * install's runtime off this computer. Its uninstaller runs it before it
 * removes the program's folder, with what the person answered to its two
 * questions (`desktop/build/installer.nsh`); the work is
 * `core/bundle-uninstall.mjs`.
 */
import os from "node:os";
import { EXIT, parseCommandLine } from "../core/cli-args.mjs";
import { uninstallBundle } from "../core/bundle-uninstall.mjs";
import { tildify } from "./context.mjs";
import { renderResults } from "./clients.mjs";

export function usage() {
  return [
    "Usage: ai-dev uninstall [--clients] [--data] [--yes] [--json]",
    "",
    "Take the Windows install's runtime off this computer: stop the daemon, remove the runtime",
    "copies in <runtime home>/app and the link AI clients run. Its uninstaller runs this before",
    "it removes the program. Without --yes it only says what it would do.",
    "",
    "  --clients  also take the ai-dev entry out of each AI client whose entry runs this install;",
    "             an entry of another install (a clone, npx, Docker) stays",
    "  --data     also delete the runtime home with everything in it: the vault AI Dev keeps,",
    "             tasks and decisions, the local model, the search index, the settings",
    "  --yes      do it",
    "  --json     print the result as JSON"
  ].join("\n");
}

function render(result, io) {
  const home = os.homedir();
  const would = result.apply ? "" : "Would: ";
  for (const daemon of result.daemons) {
    if (daemon.stopped && !daemon.gone) io.out(`Stopped the daemon, pid ${daemon.pid}.`);
    else if (!daemon.stopped) io.out(`The daemon, pid ${daemon.pid}, did not stop: ${daemon.reason ?? "it is still running"}.`);
  }
  if (result.clients.length) {
    io.out(`${would}AI clients:`);
    for (const line of renderResults(result.clients, { home })) io.out(line);
  }
  for (const folder of result.copies.removed) io.out(`${would}Removed the runtime ${tildify(folder, home)}.`);
  for (const { folder, reason } of result.copies.left) io.out(`Left the runtime ${tildify(folder, home)}: ${reason}.`);
  if (result.link === "removed" || result.link === "would-remove") io.out(`${would}Removed the link AI clients run.`);
  if (result.data.asked) {
    if (result.data.reason) io.out(`Kept ${tildify(result.runtime_home, home)}: ${result.data.reason}`);
    else io.out(`${would}Deleted ${tildify(result.runtime_home, home)} and everything in it.`);
  }
  if (!result.apply) io.out("Nothing changed: run it again with --yes.");
}

/**
 * @param {string[]} argv
 * @param {import("./context.mjs").CliIo} io
 * @returns {Promise<number>}
 */
export async function run(argv, io) {
  const { values } = parseCommandLine(argv, {
    command: "uninstall",
    options: { clients: { type: "boolean" }, data: { type: "boolean" }, yes: { type: "boolean" }, json: { type: "boolean" } }
  });
  if (values.help) {
    io.out(usage());
    return EXIT.ok;
  }
  const result = await uninstallBundle({ env: io.env, clients: values.clients === true, data: values.data === true, apply: values.yes === true });
  if (values.json) io.out(JSON.stringify(result, null, 2));
  else render(result, io);
  const failed = result.copies.left.length > 0
    || result.daemons.some((daemon) => !daemon.stopped)
    || result.clients.some((client) => client.status === "failed")
    || (result.data.asked && result.apply && !result.data.removed);
  return failed ? EXIT.failed : EXIT.ok;
}
