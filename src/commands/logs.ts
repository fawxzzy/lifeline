import { tailLogFile } from "../core/log-store.js";
import { readReleaseOperatorEvidence } from "../core/release-state.js";
import { getAppState } from "../core/state-store.js";

export async function runLogsCommand(
  appName: string,
  lineCount = 100,
): Promise<number> {
  const state = await getAppState(appName);
  if (!state) {
    console.error(`No runtime state found for app ${appName}.`);
    return 1;
  }

  const releaseEvidence = await readReleaseOperatorEvidence(appName);
  const lines = await tailLogFile(state.logPath, lineCount);
  if (lines.length === 0) {
    console.log(`No logs found for app ${appName} at ${state.logPath}.`);
    return 0;
  }

  if (releaseEvidence) {
    console.log(`=== lifeline logs ${appName} ===`);
    console.log(`- log: ${state.logPath}`);
    if (releaseEvidence.current) {
      console.log(`- currentReleaseId: ${releaseEvidence.current.releaseId}`);
    }
    if (releaseEvidence.previous) {
      console.log(`- previousReleaseId: ${releaseEvidence.previous.releaseId}`);
    }
    console.log("");
  }

  console.log(lines.join("\n"));
  return 0;
}
