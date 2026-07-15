import {
  getLifelineRoot,
  getLifelineStateDirectory,
} from "../core/lifeline-root.js";
import {
  formatPreflightFailure,
  formatPreflightSuccess,
  runPreflightChecks,
} from "../core/preflight.js";

export async function runDoctorCommand(args: string[] = []): Promise<number> {
  if (args.length > 0) {
    console.error(
      `Unknown doctor option: ${args[0]}. The doctor command does not accept arguments.`,
    );
    return 1;
  }

  console.log(`Resolved Lifeline home: ${getLifelineRoot()}`);
  console.log(
    `Resolved Lifeline state directory: ${getLifelineStateDirectory()}`,
  );

  const report = await runPreflightChecks();
  if (report.ok) {
    for (const line of formatPreflightSuccess(report, "Doctor preflight")) {
      console.log(line);
    }
    return 0;
  }

  for (const line of formatPreflightFailure(report, "Doctor preflight")) {
    console.error(line);
  }
  return 1;
}
