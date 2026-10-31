import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { validateLeoReleaseVersion, verifyLeoRelease } from "./verify-leo-release.ts";

it("rejects preview versions, invalid versions, and shell metacharacters", () => {
  for (const version of [
    "0.1.3-preview.20261031.1",
    "01.2.3",
    "1.2",
    "1.2.3;echo test",
    "../1.2.3",
  ]) {
    assert.throws(() => validateLeoReleaseVersion(version));
  }
});

it.effect("verifies release bytes and rejects mismatched, missing, or redirected artifacts", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "leo-release-test-" });
    const installer = "T3-Code-Leo-0.1.3-x64.exe";
    const payload = Buffer.from("release fixture");
    const sha512 = Buffer.from(yield* crypto.digest("SHA-512", payload)).toString("base64");
    const manifest = `version: 0.1.3\nfiles:\n  - url: ${installer}\n    sha512: ${sha512}\n    size: ${payload.length}\npath: ${installer}\nsha512: ${sha512}\nreleaseDate: '2026-10-31T12:00:00.000Z'\n`;
    const manifestPath = path.join(directory, "latest.yml");
    yield* fs.writeFile(path.join(directory, installer), payload);
    yield* fs.writeFileString(path.join(directory, `${installer}.blockmap`), "blockmap fixture");
    yield* fs.writeFileString(manifestPath, manifest);
    assert.deepEqual(yield* verifyLeoRelease(directory, "0.1.3"), [
      installer,
      `${installer}.blockmap`,
      "latest.yml",
      "SHA256SUMS.txt",
    ]);
    assert.include(
      yield* fs.readFileString(path.join(directory, "SHA256SUMS.txt")),
      Buffer.from(yield* crypto.digest("SHA-256", payload)).toString("hex"),
    );
    assert.isTrue(Exit.isFailure(yield* Effect.exit(verifyLeoRelease(directory, "0.1.4"))));
    for (const invalid of [
      manifest.replace(`url: ${installer}`, "url: ../other.exe"),
      manifest.replace(`path: ${installer}`, "path: other.exe"),
      manifest.replace(`size: ${payload.length}`, "size: 999"),
      manifest.replace(`    sha512: ${sha512}`, "    sha512: wrong"),
      manifest.replace("version: 0.1.3", "version: 0.1.4"),
      manifest + `path: ${installer}\n`,
    ]) {
      yield* fs.writeFileString(manifestPath, invalid);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(verifyLeoRelease(directory, "0.1.3"))));
    }
    yield* fs.writeFileString(manifestPath, manifest);
    yield* fs.remove(path.join(directory, `${installer}.blockmap`));
    assert.isTrue(Exit.isFailure(yield* Effect.exit(verifyLeoRelease(directory, "0.1.3"))));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
