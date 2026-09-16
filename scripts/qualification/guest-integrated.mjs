import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile, lstat, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readBounded } from "../update/prepare-release.mjs";
import { dispatchActivation } from "../update/dispatch-preparation.mjs";
import { activateAuthenticatedUpdate } from "../update/activate-authenticated.mjs";
import { createActivationJob } from "../update/update-job.mjs";
import { prepareMatrixUpdate } from "./prepared-reuse.mjs";
import { digestDistributionFile } from "../installation/prepare-distribution.mjs";
import { snapshotRegisteredProject } from "./preservation.mjs";
import {
  createEvidenceWriter,
  runIntegratedFlow,
  requireQualificationSpace,
} from "./integrated-flow.mjs";
import { interruptionCases, runInterruptionMatrix } from "./interruption-matrix.mjs";
import { createWindowsMatrixOperations } from "./windows-matrix.mjs";
import { sha256 } from "../update/release-manifest.mjs";
import { readReviewedBaseline } from "./reviewed-baseline.mjs";
import { retireReviewedPayloads } from "./retired-payloads.mjs";
import { seedBee, finishDataset, resumeMissingBeeDataset } from "./integrated-dataset.mjs";
import {
  runFocusedInterruption,
  requiredQualificationArtifacts,
  focusedContinuationAdmission,
} from "./focused-interruption.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const json = async (file) => JSON.parse(await readBounded(file, 8 * 1024 * 1024));
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(?:GIT_|NODE_|HONEYBEE_)/iu.test(key)),
);
const run = (file, args, options = {}) =>
  promisify(execFile)(file, args, {
    env,
    windowsHide: true,
    timeout: 30 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
const inspect = async () =>
  JSON.parse(
    (
      await run("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(root, "scripts/qualification/inspect-integrated-guest.ps1"),
      ])
    ).stdout,
  );
let evidence;
try {
  assert.equal(process.platform, "win32");
  const args = process.argv.slice(2);
  assert(
    args.length === 0 ||
      (args.length === 1 && args[0] === "--resume-missing-bee-dataset") ||
      (args.length === 2 &&
        ["--retry-case", "--only-case", "--resume-focused-baseline"].includes(args[0]) &&
        interruptionCases.some((c) => c.id === args[1])),
    "Only a fixed affected-case retry is allowed",
  );
  const retryCase = args[0] === "--retry-case" ? args[1] : undefined;
  const resumeFocusedBaseline = args[0] === "--resume-focused-baseline";
  const onlyCase = args[0] === "--only-case" || resumeFocusedBaseline ? args[1] : undefined;
  if (resumeFocusedBaseline) assert.equal(onlyCase, "poweroff-service-replaced");
  const pin = await json(path.join(root, "guest.json"));
  const guest = await inspect();
  assert.equal(guest.computerName, pin.computerName, "Wrong QA computer");
  assert.equal(guest.userSid, pin.userSid, "Use the original QA user");
  assert.equal(guest.elevated, false, "Run without administrator elevation");
  evidence = path.join(root, onlyCase ? `Evidence-focused-${onlyCase}` : "Evidence");
  const resume = await lstat(evidence).then(
    () => true,
    (e) => {
      if (e.code === "ENOENT") return false;
      throw e;
    },
  );
  const inputs = await json(path.join(root, "inputs.json"));
  let reviewed;
  if (resumeFocusedBaseline) assert(resume, "Existing focused preflight required");
  if ((!resume || resumeFocusedBaseline) && inputs.reviewedBaseline) {
    reviewed = await readReviewedBaseline({
      installationRoot: guest.installationRoot,
      specification: inputs.reviewedBaseline,
      ...(resumeFocusedBaseline ? { repairReview: "preserved-20260916T035057" } : {}),
    });
  }
  if (!resume && !inputs.reviewedBaseline) {
    assert.equal(
      guest.installationExists,
      false,
      "Existing installation preserved: a clean QA baseline is required",
    );
    assert.equal(
      guest.storeExists,
      false,
      "Existing storage preserved: a clean QA baseline is required",
    );
    assert.equal(
      guest.service,
      null,
      "Existing service preserved: a clean QA baseline is required",
    );
  }
  const inputsSha256 = sha256(await readBounded(path.join(root, "inputs.json"), 8 * 1024 * 1024));
  for (const artifact of requiredQualificationArtifacts(inputs.artifacts, onlyCase)) {
    assert(
      /^[A-Za-z0-9._/-]+$/u.test(artifact.destination) &&
        artifact.destination.split("/").every((p) => p && p !== "." && p !== ".."),
      "Unsafe bundle path",
    );
    assert.deepEqual(await digestDistributionFile(path.join(root, artifact.destination)), {
      sha256: artifact.sha256,
      size: artifact.size,
    });
  }
  await run("git.exe", ["--version"]);
  if (reviewed && inputs.reviewedBaseline.retiredPayloads) {
    await retireReviewedPayloads(root, inputs.reviewedBaseline.retiredPayloads);
    guest.freeBytes = (await inspect()).freeBytes;
  }
  let capacityAdmission;
  if (onlyCase === "poweroff-service-replaced") {
    const previous = await createEvidenceWriter(
      path.join(root, "Evidence-focused-reboot-service-replaced"),
      { resume: true },
    );
    capacityAdmission = focusedContinuationAdmission({
      caseId: onlyCase,
      history: previous.history,
      candidate: inputs.candidate,
      inputsSha256,
      guest,
    });
  }
  if (!resume) requireQualificationSpace(guest.freeBytes, capacityAdmission);
  const persist = await createEvidenceWriter(evidence, { resume });
  if (resume) {
    const initial = persist.history.find((e) => e.phase === "preflight" && e.state === "Completed");
    assert(initial, "Previous preflight proof missing");
    assert.deepEqual(initial.result.candidate, inputs.candidate, "Resume candidate differs");
    assert.equal(
      initial.result.inputsSha256,
      inputsSha256,
      "QA baseline, media or matrix inputs changed",
    );
    assert.equal(initial.result.guest.userSid, guest.userSid);
    assert.equal(initial.result.guest.computerName, guest.computerName);
    assert.equal(initial.result.guest.installationRoot, guest.installationRoot);
    assert.equal(initial.result.focusedCase, onlyCase, "QA execution scope changed");
    requireQualificationSpace(guest.freeBytes, capacityAdmission ?? initial);
    process.stdout.write(
      `Resuming admitted QA run: ${(guest.freeBytes / 1024 ** 3).toFixed(2)} GiB free; product capacity checks remain enabled.\n`,
    );
  }
  if (args[0] === "--resume-missing-bee-dataset") {
    assert(resume, "Reviewed dataset recovery requires existing evidence");
    assert(persist.history.some((e) => e.phase === "dataset" && e.state === "Failed"));
  }
  const record = async (event) => {
    await persist(event);
    process.stdout.write(`${event.phase}: ${event.state}\n`);
  };
  record.history = persist.history;
  const installationRoot = guest.installationRoot;
  const cli = async (args) => {
    const result = JSON.parse(
      (await run(path.join(installationRoot, "bin/honeybee.exe"), [...args, "--json"])).stdout,
    );
    assert.equal(result.ok, true);
    return result;
  };
  const setup = (name, args = []) => run(path.join(root, name), args, { windowsHide: false });
  const health = async (version, component) => {
    assert.equal((await json(path.join(installationRoot, "current.json"))).activeVersion, version);
    const receipt = await json(path.join(guest.storeRoot, "install-receipt.json"));
    assert.equal(receipt.userSid, pin.userSid);
    assert.equal(receipt.componentVersion, component.componentVersion);
    assert.equal(receipt.executableSha256, component.host.sha256);
    assert.deepEqual(await digestDistributionFile(receipt.executable), component.host);
    const state = await inspect();
    assert.equal(state.service?.State, "Running");
    assert.equal(state.service.StartName, "LocalSystem");
    const doctor = await cli(["doctor"]);
    assert.equal(doctor.ready, true);
    assert.equal(doctor.summary.fail, 0);
    return { doctor, receipt, service: state.service };
  };
  const operations = {
    assertNoCaseStarted: async (caseId) => {
      const entries = await readdir(path.join(root, "Matrix"));
      assert(
        !entries.some((name) => name.startsWith(caseId + "-attempt-")),
        "Power-off attempt already exists; baseline replay refused",
      );
    },
    preflight: async () => ({
      guest,
      candidate: inputs.candidate,
      inputsSha256,
      ...(onlyCase ? { focusedCase: onlyCase } : {}),
      ...(capacityAdmission ? { capacityAdmission } : {}),
    }),
    baseline: async () => {
      if (inputs.reviewedBaseline) {
        assert(reviewed, "Reviewed baseline required before reuse");
        return {
          ...(await health(inputs.servicePair.source.version, inputs.servicePair.source)),
          reused: true,
          freshSetup: false,
        };
      }
      await setup("HoneyBeeSetup-qualification-baseline.exe");
      return health(inputs.servicePair.source.version, inputs.servicePair.source);
    },
    dataset: async () => {
      if (inputs.reviewedBaseline) {
        assert(reviewed);
        return reviewed.dataset;
      }
      const directory = path.join(root, "QA 데이터"),
        project = path.join(directory, "Unity 프로젝트");
      await mkdir(directory); // never adopt or delete a previous dataset
      await mkdir(project);
      for (const name of ["Assets", "Packages", "ProjectSettings", "Library"])
        await mkdir(path.join(project, name));
      await writeFile(path.join(project, ".gitignore"), "Library/\nTemp/\n");
      await writeFile(path.join(project, "Assets/Source.txt"), "committed source\n");
      await writeFile(path.join(project, "Packages/manifest.json"), '{"dependencies":{}}\n');
      await writeFile(
        path.join(project, "ProjectSettings/ProjectVersion.txt"),
        "m_EditorVersion: 6000.0.0f1\n",
      );
      await writeFile(
        path.join(project, "Library/qa-cache.txt"),
        "Synthetic cache seed for real VHDX lifecycle qualification.\n",
      );
      await seedBee(project);
      const git = (args) =>
        run("git.exe", [
          "-c",
          `safe.directory=${project}`,
          "-c",
          "core.hooksPath=NUL",
          "-c",
          "user.name=HoneyBee QA",
          "-c",
          "user.email=qa@example.invalid",
          "-C",
          project,
          ...args,
        ]);
      await git(["init", "--initial-branch=main"]);
      await git(["add", "."]);
      await git(["commit", "-m", "Disposable qualification dataset"]);
      const registered = await cli([
        "project",
        "init",
        project,
        "--workspace-root",
        path.join(directory, "Workspaces"),
      ]);
      const projectId = registered.project.projectId;
      return finishDataset({ root, project, projectId, cli });
    },
    health,
    snapshot: (dataset) =>
      snapshotRegisteredProject({ installationRoot, projectId: dataset.projectId }),
    update: async (step) => {
      const prepared = await prepareMatrixUpdate({ installationRoot, bundle: root, step });
      if (inputs.reviewedBaseline) {
        // The admitted external runner contains the qualified activity fix; the
        // old immutable source runtime is not silently replaced or patched.
        const job = await createActivationJob({ ...prepared, setupActivation: true });
        const request = await json(path.join(job.directory, "request.json"));
        const result = await activateAuthenticatedUpdate({
          installationRoot,
          runtime: path.join(installationRoot, "recovery/v1"),
          request,
          activationJob: { directory: job.directory, requestSha256: job.sha256 },
        });
        return { ...result, ready: result.state === "Committed" };
      }
      const state = await dispatchActivation({ ...prepared, setupActivation: true });
      return { state, ready: state === "Committed" };
    },
    repair: async () => {
      await setup("HoneyBeeSetup.exe", ["/REPAIR"]);
      return { completed: true, scope: "matching-Setup-idempotent-Repair" };
    },
  };
  if (args[0] === "--resume-missing-bee-dataset") {
    operations.resumeDataset = async () =>
      resumeMissingBeeDataset({
        root,
        guest,
        run,
        cli,
        registry: await json(
          path.join(installationRoot, "workspace-core/workspace-registry-v2.json"),
        ),
        health: () => health(inputs.servicePair.source.version, inputs.servicePair.source),
      });
  }
  const matrixOperations = createWindowsMatrixOperations({
    bundle: root,
    installationRoot,
    inputs,
    health,
    snapshot: operations.snapshot,
    bootId: async () => (await inspect()).bootTime,
    env,
  });
  operations.failureMatrix = (kind, dataset, before) =>
    runInterruptionMatrix({
      directory: path.join(root, "Matrix"),
      kind,
      candidate: { ...inputs.candidate, inputsSha256 },
      before,
      dataset,
      operations: matrixOperations,
      retryCase,
      onlyCase,
    });
  const result = onlyCase
    ? await runFocusedInterruption({
        caseId: onlyCase,
        operations,
        record,
        reviewed,
        resumeBaseline: resumeFocusedBaseline,
      })
    : await runIntegratedFlow({ inputs, operations, record });
  process.stdout.write(JSON.stringify({ ...result, evidence }, null, 2) + "\n");
  if (result.pendingRestart) process.exitCode = 10;
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      completed: false,
      error: String(error),
      evidence,
      existingDataPreservedByCleanupPolicy: true,
      automaticReplay: false,
    }) + "\n",
  );
  process.exitCode = 1;
}
