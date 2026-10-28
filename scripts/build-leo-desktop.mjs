import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL("./build-desktop-artifact.ts", import.meta.url)),
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
