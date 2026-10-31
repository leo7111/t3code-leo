import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Command, Flag } from "effect/cli";

import { parseUpdateManifest } from "./lib/update-manifest.ts";

class LeoReleaseError extends Data.TaggedError("LeoReleaseError")<{ readonly message: string }> {}

export function validateLeoReleaseVersion(version: string): void {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("Leo releases require a stable version such as 0.1.3.");
  }
}

export const verifyLeoRelease = Effect.fn("verifyLeoRelease")(function* (
  directory: string,
  version: string,
) {
  yield* Effect.try(() => validateLeoReleaseVersion(version));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const installer = `T3-Code-Leo-${version}-x64.exe`;
  const filenames = [installer, `${installer}.blockmap`, "latest.yml"];
  for (const filename of filenames) {
    const metadata = yield* fs.stat(path.join(directory, filename));
    if (metadata.type !== "File" || Number(metadata.size) === 0) {
      return yield* new LeoReleaseError({
        message: `Release artifact must be a nonempty regular file: ${filename}`,
      });
    }
  }
  const manifestPath = path.join(directory, "latest.yml");
  const raw = yield* fs.readFileString(manifestPath);
  const manifest = yield* Effect.try(() =>
    parseUpdateManifest(raw, manifestPath, "Leo Windows x64"),
  );
  const entry = manifest.files[0];
  if (manifest.version !== version || manifest.files.length !== 1 || entry?.url !== installer) {
    return yield* new LeoReleaseError({
      message: "Release manifest must describe exactly the expected Leo Windows x64 installer.",
    });
  }
  for (const [key, expected] of [
    ["path", installer],
    ["sha512", entry.sha512],
  ] as const) {
    const values = raw.split(/\r?\n/).filter((line) => line.startsWith(`${key}:`));
    const value = values[0]?.slice(key.length + 1).trim();
    if (values.length !== 1 || (value !== expected && value !== `'${expected}'`)) {
      return yield* new LeoReleaseError({
        message: `Legacy manifest ${key} must match the installer entry.`,
      });
    }
  }
  const checksums: string[] = [];
  for (const filename of filenames) {
    const bytes = yield* fs.readFile(path.join(directory, filename));
    if (filename === installer) {
      const sha512 = Buffer.from(yield* crypto.digest("SHA-512", bytes)).toString("base64");
      if (bytes.length !== entry.size || sha512 !== entry.sha512) {
        return yield* new LeoReleaseError({
          message: "Installer size or SHA-512 does not match latest.yml.",
        });
      }
    }
    const sha256 = Buffer.from(yield* crypto.digest("SHA-256", bytes)).toString("hex");
    checksums.push(`${sha256}  ${filename}\n`);
  }
  yield* fs.writeFileString(path.join(directory, "SHA256SUMS.txt"), checksums.join(""));
  return [...filenames, "SHA256SUMS.txt"];
});

const command = Command.make(
  "verify-leo-release",
  {
    directory: Flag.String("directory"),
    version: Flag.String("version"),
  },
  ({ directory, version }) =>
    verifyLeoRelease(directory, version).pipe(
      Effect.tap((files) => Effect.log(`Verified Leo ${version}: ${files.join(", ")}`)),
    ),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
