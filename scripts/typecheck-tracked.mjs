// Typecheck the deployable tree, without including the owner's untracked
// experiments. No config files or generated compiler outputs are written.
import { execFileSync } from "node:child_process";
import ts from "typescript";

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0").filter((name) => /\.(?:ts|tsx|mts)$/.test(name));
const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists, "tsconfig.json");
if (!configPath) throw new Error("tsconfig.json not found");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
// next-env.d.ts is generated and ignored by git, but declares Next's types.
const rootNames = [...tracked, "next-env.d.ts"];
const program = ts.createProgram(rootNames, { ...parsed.options, incremental: false, noEmit: true });
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => "\n",
  }));
  process.exitCode = 1;
} else console.log(`Typecheck passed (${tracked.length} tracked TypeScript files).`);
