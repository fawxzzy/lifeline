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
    console.log(`- receiptContractVersion: ${releaseEvidence.receiptHealth.contractVersion}`);
    if (releaseEvidence.latestReceipt) {
      console.log(
        `- latestReceipt: ${releaseEvidence.latestReceipt.receiptId} ${releaseEvidence.latestReceipt.action} ${releaseEvidence.latestReceipt.status} ${releaseEvidence.latestReceipt.releaseId} (${releaseEvidence.latestReceipt.path})`,
      );
    }
    if (releaseEvidence.receiptHealth.status === "ok") {
      console.log("- receiptHealth: ok");
    } else {
      const reasons = [];
      if (releaseEvidence.receiptHealth.versionMismatchCount > 0) {
        reasons.push(
          `versionMismatch=${releaseEvidence.receiptHealth.versionMismatchCount}`,
        );
      }
      if (releaseEvidence.receiptHealth.invalidReceiptCount > 0) {
        reasons.push(`invalid=${releaseEvidence.receiptHealth.invalidReceiptCount}`);
      }
      if (releaseEvidence.receiptHealth.unreadableReceiptCount > 0) {
        reasons.push(
          `unreadable=${releaseEvidence.receiptHealth.unreadableReceiptCount}`,
        );
      }
      if (releaseEvidence.receiptHealth.missingLatestReceipt) {
        reasons.push("missingLatestReceipt=yes");
      }
      console.log(
        `- receiptHealth: degraded${reasons.length > 0 ? ` (${reasons.join(", ")})` : ""}`,
      );
    }
    console.log("");
  }

  console.log(lines.join("\n"));
  return 0;
}
