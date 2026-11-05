import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Path from "effect/Path";
import * as NodeZlib from "node:zlib";
import * as Layer from "effect/Layer";
import * as ModelManifest from "./ModelManifest.ts";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Digest from "effect/crypto/Digest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as CodexInstallation from "./CodexInstallation.ts";

const hostPlatform = HostProcess.Platform.defaultValue();
const hostArchitecture = HostProcess.Architecture.defaultValue();
const executableExtension = hostPlatform === "win32" ? ".exe" : "";
const target = `${hostArchitecture === "arm64" ? "aarch64" : "x86_64"}-${
  hostPlatform === "win32"
    ? "pc-windows-msvc"
    : hostPlatform === "darwin"
      ? "apple-darwin"
      : "unknown-linux-musl"
}`;
const archive = NodeZlib.gzipSync(
  Buffer.concat([
    ...(
      [
        [`bin/codex${executableExtension}`, "codex"],
        [`bin/codex-code-mode-host${executableExtension}`, "host"],
        [`codex-path/rg${executableExtension}`, "rg"],
        [
          "codex-package.json",
          JSON.stringify({
            layoutVersion: 1,
            version: "0.156.1",
            target,
            entrypoint: `bin/codex${executableExtension}`,
          }),
        ],
      ] as const
    ).flatMap(([name, content]) => {
      const body = Buffer.from(content);
      const header = Buffer.alloc(512);
      header.write(name, 0);
      header.write("0000755\0", 100);
      header.write("0000000\0", 108);
      header.write("0000000\0", 116);
      header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
      header.write("00000000000\0", 136);
      header.fill(0x20, 148, 156);
      header.write("0", 156);
      header.write("ustar\0", 257);
      header.write("00", 263);
      const checksum = header.reduce((sum, byte) => sum + byte, 0);
      header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
      return [header, body, Buffer.alloc((512 - (body.length % 512)) % 512)];
    }),
    Buffer.alloc(1024),
  ]),
);
const asset = {
  version: "0.156.1",
  target,
  url: "https://github.com/openai/codex/releases/download/test/package.tar.gz",
  archiveBytes: archive.length,
};
const writeLocalCli = Effect.fn("test.writeLocalCli")(function* (
  binaryPath: string,
  probeLog: string,
  local: { version: string; appServerFails?: boolean; versionFails?: boolean; native?: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const payload = `${binaryPath}.cjs`;
  yield* fs.writeFileString(
    payload,
    `const fs = require("node:fs");
const path = require("node:path");
if (${Boolean(local.native)} && path.basename(process.argv0) !== ${JSON.stringify(path.basename(binaryPath))}) process.exit(1);
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(probeLog)}, args.join(" ") + "\\n");
if (args[0] === "--version") {
  if (${Boolean(local.versionFails)}) process.exit(1);
  console.log(${JSON.stringify(`codex-cli ${local.version}`)});
} else if (args[0] === "app-server" && args[1] === "--help") {
  process.exit(${local.appServerFails ? 1 : 0});
} else process.exit(1);
`,
  );
  if (local.native) {
    yield* fs.copyFile(process.execPath, binaryPath);
  } else {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    yield* fs.writeFileString(
      binaryPath,
      hostPlatform === "win32"
        ? `@echo off\r\nif not "%~n0"=="codex" exit /b 1\r\n"${process.execPath}" "${payload}" %*\r\n`
        : `#!/bin/sh\ncase "$0" in */codex) ;; *) exit 1;; esac\nexec ${quote(process.execPath)} ${quote(payload)} "$@"\n`,
      { mode: 0o755 },
    );
  }
});
const makeHarness = Effect.fn("test.makeCodexInstallation")(function* (
  input: {
    options?: Partial<CodexInstallation.CodexInstallationOptions>;
    manifestCurrent?: Effect.Effect<ModelManifest.ModelManifestData>;
    body?: Stream.Stream<Uint8Array, HttpClientError.HttpClientError>;
    downloadStatus?: number;
    baseDir?: string;
    local?: {
      version: string;
      appServerFails?: boolean;
      versionFails?: boolean;
      native?: boolean;
    };
    spawner?: ChildProcessSpawner.ChildProcessSpawner["Service"];
    runtimeRenameFailures?: number;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir =
    input.baseDir ?? (yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-install-test-" }));
  const localDirectory = path.join(baseDir, "local");
  const localBinaryPath = path.join(
    localDirectory,
    `codex${input.local?.native ? executableExtension.toUpperCase() : hostPlatform === "win32" ? ".CMD" : ""}`,
  );
  const probeLog = path.join(baseDir, "local-probes.txt");
  const localPayload = `${localBinaryPath}.cjs`;
  if (input.local) {
    yield* fs.makeDirectory(localDirectory, { recursive: true });
    yield* writeLocalCli(localBinaryPath, probeLog, input.local);
  }
  let downloads = 0;
  const digest = yield* Digest.Digest;
  const sha256 = Hex.encode(yield* digest.digest(Digest.sha256, archive).pipe(Effect.orDie));
  let runtimeRenameFailures = input.runtimeRenameFailures ?? 0;
  const failedRenames = yield* Queue.unbounded<void>();
  const lockingFs: FileSystem.FileSystem = {
    ...fs,
    // Suspended so each retry of the same effect is a fresh attempt, like the real rename.
    rename: (from, to) =>
      Effect.suspend(() =>
        /[/\\]runtime$/u.test(from) && runtimeRenameFailures-- > 0
          ? Queue.offer(failedRenames, undefined).pipe(
              Effect.andThen(
                Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "rename",
                    pathOrDescriptor: from,
                  }),
                ),
              ),
            )
          : fs.rename(from, to),
      ),
  };
  const spawner = input.spawner ?? (yield* ChildProcessSpawner.ChildProcessSpawner);
  const fixtureSpawner = ChildProcessSpawner.make((command) =>
    spawner.spawn(
      input.local?.native &&
        command._tag === "StandardCommand" &&
        command.command === localBinaryPath
        ? ChildProcess.make(command.command, [localPayload, ...command.args], command.options)
        : command,
    ),
  );
  const installation = yield* CodexInstallation.makeCodexInstallation({
    baseDir,
    releaseAsset: { ...asset, sha256 },
    validate: () => Effect.void,
    ...input.options,
  }).pipe(
    Effect.provideService(ModelManifest.ModelManifest, {
      current: input.manifestCurrent ?? Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
      refresh: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
      forceRefresh: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
      refreshInBackground: Effect.void,
    }),
    Effect.provideService(HostProcess.Platform, hostPlatform),
    Effect.provideService(HostProcess.Architecture, hostArchitecture),
    Effect.provideService(HostProcess.Environment, {
      PATH: input.local ? localDirectory : "",
      SystemRoot: (yield* HostProcess.Environment).SystemRoot ?? "C:\\Windows",
    }),
    Effect.provideService(FileSystem.FileSystem, lockingFs),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fixtureSpawner),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          downloads++;
          return Object.defineProperty(
            HttpClientResponse.fromWeb(
              request,
              new Response(null, { status: input.downloadStatus ?? 200 }),
            ),
            "stream",
            {
              value: input.body ?? Stream.succeed(archive),
            },
          );
        }),
      ),
    ),
  );
  return {
    installation,
    fs,
    baseDir,
    localBinaryPath,
    localPayload,
    probeLog,
    failedRenames,
    downloads: () => downloads,
  };
});
const terminalState = (installation: CodexInstallation.CodexInstallation["Service"]) =>
  installation.changes.pipe(
    Stream.filter((state) => ["succeeded", "failed", "cancelled"].includes(state.phase)),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

it.effect.each(["0.156.0", "0.156.1", "0.156.2", "0.157.0"])(
  "reuses installed Codex %s without downloading or taking ownership of it",
  (version) =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ local: { version } });
      expect(yield* h.installation.start).toMatchObject({
        source: "local",
        phase: "succeeded",
        installedVersion: version,
        executablePath: h.localBinaryPath,
        canRemove: false,
      });
      expect(yield* h.installation.resolve()).toMatchObject({
        source: "local",
        executablePath: h.localBinaryPath,
        managedVersionDirectory: null,
        version,
      });
      yield* h.installation.acquire().pipe(Effect.scoped);
      expect(h.downloads()).toBe(0);
      expect(yield* h.fs.exists(h.installation.managedDirectory)).toBe(false);
      expect((yield* h.fs.readFileString(h.probeLog)).trim().split("\n")).toEqual([
        "--version",
        "app-server --help",
      ]);
      yield* h.installation.remove();
      expect(yield* h.fs.exists(h.localBinaryPath)).toBe(true);
      expect((yield* h.installation.state).source).toBe("local");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
it.effect.each([
  { version: "0.128.9" },
  { version: "0.145.0" },
  { version: "0.155.1" },
  { version: "0.155.9" },
  { version: "0.156.1-alpha.1" },
  { version: "unknown" },
  { version: "0.156.1", appServerFails: true },
  { version: "0.156.1", versionFails: true },
])("downloads the pinned release when the local CLI is unsupported or broken: %j", (local) =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ local });
    expect((yield* h.installation.state).installedVersion).toBeNull();
    yield* h.installation.start;
    const installed = yield* terminalState(h.installation);
    expect(installed.phase).toBe("succeeded");
    const executable = yield* h.installation.resolve();
    expect(executable.source).toBe("managed");
    expect(installed.executablePath).toBe(executable.executablePath);
    expect(h.downloads()).toBe(1);
    expect(yield* h.fs.exists(h.localBinaryPath)).toBe(true);
    expect((yield* h.fs.readFileString(h.probeLog)).trim().split("\n")).toEqual(
      ("versionFails" in local && local.versionFails) || !/^\d+\.\d+\.\d+$/u.test(local.version)
        ? ["--version"]
        : ["--version", "app-server --help"],
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("rechecks compatibility after the local executable is replaced", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ local: { version: "0.156.1" } });
    expect((yield* h.installation.resolve()).source).toBe("local");
    yield* h.fs.remove(h.localBinaryPath);
    yield* writeLocalCli(h.localBinaryPath, h.probeLog, { version: "0.128.9" });
    yield* h.fs.utimes(h.localBinaryPath, 0, 0);
    yield* h.installation.start;
    expect((yield* terminalState(h.installation)).phase).toBe("succeeded");
    expect((yield* h.installation.resolve()).source).toBe("managed");
    expect(h.downloads()).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("rechecks a cached local executable when the shared manifest policy changes", () =>
  Effect.gen(function* () {
    let manifest = ModelManifest.BUNDLED_MODEL_MANIFEST;
    const h = yield* makeHarness({
      local: { version: "0.156.0" },
      manifestCurrent: Effect.sync(() => manifest),
    });
    expect((yield* h.installation.resolve()).source).toBe("local");
    manifest = {
      ...manifest,
      compatibility: [
        {
          driver: "codex",
          t3CodeRange: ">=0.0.42",
          ranges: [
            { range: ">=0.156.1", status: "supported" },
            { range: "<0.156.1", status: "broken" },
          ],
        },
      ],
    };
    yield* h.installation.start;
    expect((yield* terminalState(h.installation)).phase).toBe("succeeded");
    expect((yield* h.installation.resolve()).source).toBe("managed");
    expect(h.downloads()).toBe(1);
    expect((yield* h.fs.readFileString(h.probeLog)).trim().split("\n")).toEqual([
      "--version",
      "app-server --help",
    ]);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("uses bundled Codex compatibility when the remote manifest omits its policy", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({
      local: { version: "0.156.0" },
      manifestCurrent: Effect.succeed({
        ...ModelManifest.BUNDLED_MODEL_MANIFEST,
        compatibility: [],
      }),
    });
    expect((yield* h.installation.start).source).toBe("local");
    expect(h.downloads()).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each([
  { kind: "script", name: "volta-shim" },
  { kind: "native", name: "volta-shim" },
  { kind: "native", name: "mise" },
  { kind: "native", name: "aqua-proxy" },
])("preserves the invoked name of $kind $name launcher symlinks", ({ kind, name }) =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ local: { version: "0.156.1", native: kind === "native" } });
    const path = yield* Path.Path;
    const launcher = path.join(
      h.baseDir,
      `${name}${hostPlatform === "win32" ? (kind === "native" ? ".exe" : ".cmd") : ""}`,
    );
    yield* h.fs.rename(h.localBinaryPath, launcher);
    if (kind === "native") {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      expect(
        yield* spawner.exitCode(ChildProcess.make(launcher, [h.localPayload, "--version"])),
      ).toBe(1);
    }
    yield* h.fs.symlink(launcher, h.localBinaryPath);
    yield* h.fs.writeFileString(h.probeLog, "");
    expect(yield* h.installation.start).toMatchObject({ source: "local", phase: "succeeded" });
    expect((yield* h.installation.resolve()).executablePath).toBe(h.localBinaryPath);
    expect(h.downloads()).toBe(0);
    expect((yield* h.fs.readFileString(h.probeLog)).trim().split("\n")).toEqual([
      "--version",
      "app-server --help",
    ]);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "installs the complete verified package in tools/codex/version and survives a restart",
  () =>
    Effect.gen(function* () {
      const { installation, fs, baseDir } = yield* makeHarness();
      const path = yield* Path.Path;
      yield* installation.start;
      expect((yield* terminalState(installation)).phase).toBe("succeeded");
      const executable = yield* installation.resolve();
      expect(executable.executablePath).toBe(
        path.join(baseDir, "tools", "codex", "0.156.1", "bin", `codex${executableExtension}`),
      );
      expect(
        yield* fs.readFileString(
          path.join(
            executable.managedVersionDirectory!,
            "bin",
            `codex-code-mode-host${executableExtension}`,
          ),
        ),
      ).toBe("host");
      expect(
        yield* fs.readFileString(
          path.join(executable.managedVersionDirectory!, "codex-path", `rg${executableExtension}`),
        ),
      ).toBe("rg");
      const restarted = yield* makeHarness({ baseDir });
      expect((yield* restarted.installation.resolve()).version).toBe("0.156.1");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("requires an update before running an older activated managed installation", () =>
  Effect.gen(function* () {
    const first = yield* makeHarness();
    yield* first.installation.start;
    yield* terminalState(first.installation);
    const executable = yield* first.installation.resolve();
    const oldDirectory = `${first.installation.managedDirectory}/0.155.1`;
    yield* first.fs.rename(executable.managedVersionDirectory!, oldDirectory);
    for (const name of ["codex-package.json", ".install-complete.json"]) {
      const file = `${oldDirectory}/${name}`;
      yield* first.fs.writeFileString(
        file,
        (yield* first.fs.readFileString(file)).replaceAll("0.156.1", "0.155.1"),
      );
    }
    yield* first.fs.writeFileString(
      `${first.installation.managedDirectory}/active.json`,
      '{"version":"0.155.1"}',
    );
    const restarted = yield* makeHarness({ baseDir: first.baseDir });
    expect((yield* Effect.flip(restarted.installation.resolve())).detail).toContain(
      "outside the supported range",
    );
    yield* restarted.installation.start;
    expect((yield* terminalState(restarted.installation)).phase).toBe("succeeded");
    expect((yield* restarted.installation.resolve()).version).toBe("0.156.1");
    expect(restarted.downloads()).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("updates an older supported managed installation to the pinned release on startup", () =>
  Effect.gen(function* () {
    const first = yield* makeHarness();
    yield* first.installation.start;
    yield* terminalState(first.installation);
    const executable = yield* first.installation.resolve();
    const oldDirectory = `${first.installation.managedDirectory}/0.156.0`;
    yield* first.fs.rename(executable.managedVersionDirectory!, oldDirectory);
    for (const name of ["codex-package.json", ".install-complete.json"]) {
      const file = `${oldDirectory}/${name}`;
      yield* first.fs.writeFileString(
        file,
        (yield* first.fs.readFileString(file)).replaceAll("0.156.1", "0.156.0"),
      );
    }
    yield* first.fs.writeFileString(
      `${first.installation.managedDirectory}/active.json`,
      '{"version":"0.156.0"}',
    );
    const restarted = yield* makeHarness({ baseDir: first.baseDir });
    expect((yield* restarted.installation.state).operationId).not.toBeNull();
    expect((yield* terminalState(restarted.installation)).phase).toBe("succeeded");
    expect((yield* restarted.installation.resolve()).version).toBe("0.156.1");
    expect(restarted.downloads()).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("rejects corrupted downloads without publishing a runtime", () =>
  Effect.gen(function* () {
    const { installation, fs } = yield* makeHarness({
      options: { releaseAsset: { ...asset, sha256: "0".repeat(64) } },
    });
    yield* installation.start;
    const state = yield* terminalState(installation);
    expect(state.phase).toBe("failed");
    expect(state.message).toContain("SHA-256");
    expect(yield* fs.exists(`${installation.managedDirectory}/active.json`)).toBe(false);
    expect(yield* fs.exists(`${installation.managedDirectory}/0.156.1`)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["interrupted body", "HTTP 404"] as const)(
  "reports a download failure for %s without blaming disk access",
  (failure) =>
    Effect.gen(function* () {
      const request = HttpClientRequest.get(asset.url);
      const response = HttpClientResponse.fromWeb(request, new Response(null));
      const h = yield* makeHarness(
        failure === "HTTP 404"
          ? { downloadStatus: 404 }
          : {
              body: Stream.concat(
                Stream.succeed(archive.subarray(0, 10)),
                Stream.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.DecodeError({
                      request,
                      response,
                      cause: new TypeError("terminated"),
                    }),
                  }),
                ),
              ),
            },
      );
      yield* h.installation.start;
      expect(yield* terminalState(h.installation)).toMatchObject({
        phase: "failed",
        message:
          failure === "HTTP 404"
            ? "The Codex download server returned HTTP 404. Try again later."
            : "The Codex download was interrupted. Check your internet connection, then retry installation.",
      });
      expect(h.downloads()).toBe(1);
      expect(yield* h.fs.readDirectory(h.installation.managedDirectory)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "preserves the filesystem failure message when installation cannot create its directory",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-install-test-" });
      const baseDir = `${directory}/not-a-directory`;
      yield* fs.writeFileString(baseDir, "existing file");
      const h = yield* makeHarness({ baseDir });
      yield* h.installation.start;
      expect(yield* terminalState(h.installation)).toMatchObject({
        phase: "failed",
        message: "Could not install Codex. Check disk space and directory access, then try again.",
      });
      expect(h.downloads()).toBe(0);
      expect(yield* fs.readFileString(baseDir)).toBe("existing file");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("reports a download timeout and cleans the staging directory", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const stall = Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
    const h = yield* makeHarness({
      body: Stream.concat(Stream.succeed(archive.subarray(0, 10)), Stream.fromEffect(stall)),
    });
    yield* h.installation.start;
    yield* Deferred.await(started);
    yield* TestClock.adjust("45 minutes");
    expect(yield* terminalState(h.installation)).toMatchObject({
      phase: "failed",
      message: "The Codex download timed out. Retry installation.",
    });
    expect(h.downloads()).toBe(1);
    expect(yield* h.fs.readDirectory(h.installation.managedDirectory)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("cancels an in-flight download and cleans the staging directory", () =>
  Effect.gen(function* () {
    const downloading = yield* Deferred.make<void>();
    const body = Stream.fromEffect(
      Deferred.succeed(downloading, undefined).pipe(Effect.andThen(Effect.never)),
    );
    const { installation, fs } = yield* makeHarness({ body });
    const started = yield* installation.start;
    yield* Deferred.await(downloading);
    expect((yield* installation.cancel(started.operationId!)).phase).toBe("cancelled");
    expect(
      (yield* fs.readDirectory(installation.managedDirectory)).filter((name) =>
        name.startsWith(".install-"),
      ),
    ).toEqual([]);
    expect(yield* fs.exists(`${installation.managedDirectory}/active.json`)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("protects active process leases and removes the runtime after release", () =>
  Effect.gen(function* () {
    const { installation, fs } = yield* makeHarness();
    yield* installation.start;
    yield* terminalState(installation);
    const leaseScope = yield* Scope.make();
    yield* installation.acquire().pipe(Effect.provideService(Scope.Scope, leaseScope));
    expect((yield* Effect.flip(installation.remove())).detail).toContain("Stop Codex sessions");
    yield* Scope.close(leaseScope, Exit.void);
    yield* installation.remove();
    expect(yield* fs.exists(installation.managedDirectory)).toBe(false);
    expect((yield* installation.state).installedVersion).toBeNull();
    expect((yield* installation.state).executablePath).toBeNull();
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("keeps an activated runtime when a later update fails verification", () =>
  Effect.gen(function* () {
    const first = yield* makeHarness();
    yield* first.installation.start;
    yield* terminalState(first.installation);
    const update = yield* makeHarness({
      baseDir: first.baseDir,
      options: { releaseAsset: { ...asset, version: "0.156.2", sha256: "0".repeat(64) } },
    });
    expect((yield* update.installation.state).executablePath).toBe(
      (yield* first.installation.resolve()).executablePath,
    );
    yield* update.installation.start;
    expect((yield* terminalState(update.installation)).phase).toBe("failed");
    expect((yield* update.installation.resolve()).version).toBe("0.156.1");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
