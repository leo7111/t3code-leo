import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

const result = NodeChildProcess.spawnSync(
  process.execPath,
  [
    NodeURL.fileURLToPath(new URL("./build-desktop-artifact.ts", import.meta.url)),
    "--platform",
    "win",
    "--target",
    "nsis",
    "--arch",
    "x64",
    "--output-dir",
    "release/leo",
    ...process.argv.slice(2),
  ],
  {
    stdio: "inherit",
    env: { ...process.env, T3CODE_BUILD_LEO: "1" },
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
