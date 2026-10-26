import { Command } from "commander";
import { writeReport } from "./lib/report.ts";

new Command()
  .name("report")
  .description("Write an ascent's HTML report to target/ascents/<name>/report.html")
  .argument("<name>", "ascent name")
  .action((name: string) => console.log(writeReport(name)))
  .parse();
