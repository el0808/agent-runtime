import { createLongTaskRR, createOfflineScenarios, BenchmarkRunner, writeReport } from "../packages/benchmark/dist/index.js";

const tasks = createLongTaskRR(30);
const report = await new BenchmarkRunner(20261027).run(createOfflineScenarios(), tasks, 1);
await writeReport(report, "reports");
