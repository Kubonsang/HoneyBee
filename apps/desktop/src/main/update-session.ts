import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, realpath, writeFile, unlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import path from "node:path";

export const openDesktopUpdateSession = async (options: {
  root: string;
  version: string;
  validationId?: string;
  isReady: () => boolean;
  shutdown: (signal: AbortSignal) => Promise<"accepted" | "cancelled">;
  quit: () => void;
}) => {
  const root = path.resolve(options.root);
  const directory = path.join(root, "update", "desktop-sessions");
  await mkdir(directory, { recursive: true });
  if ((await realpath(directory)).toLowerCase() !== directory.toLowerCase())
    throw new Error("Redirected Desktop session directory");
  const sessionId = randomUUID();
  const token = randomBytes(32).toString("hex");
  const pipe = `\\\\.\\pipe\\HoneyBee-Desktop-${sessionId}`;
  const descriptor = path.join(directory, `${sessionId}.json`);
  const sockets = new Set<Socket>();
  let busy = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    const abort = new AbortController();
    socket.on("error", () => {});
    socket.once("close", () => {
      sockets.delete(socket);
      abort.abort();
    });
    socket.setTimeout(120000, () => socket.destroy());
    let input = "";
    let handled = false;
    socket.on("data", (bytes: Buffer) => {
      if (handled) {
        socket.destroy();
        return;
      }
      input += bytes.toString("utf8");
      if (Buffer.byteLength(input) > 4096) {
        socket.destroy();
        return;
      }
      if (!input.endsWith("\n")) return;
      handled = true;
      void (async () => {
        const request = JSON.parse(input) as Record<string, unknown>;
        if (
          typeof request.token !== "string" ||
          request.token.length !== token.length ||
          !timingSafeEqual(Buffer.from(request.token), Buffer.from(token)) ||
          request.sessionId !== sessionId ||
          request.root !== root ||
          typeof request.requestId !== "string" ||
          !/^[a-f0-9-]{36}$/u.test(request.requestId)
        )
          throw new Error("Invalid Desktop request");
        const respond = (status: string, callback?: () => void) =>
          socket.end(
            JSON.stringify({
              schemaVersion: 1,
              requestId: request.requestId,
              sessionId,
              root,
              version: options.version,
              status,
              ...(options.validationId === undefined
                ? {}
                : { mode: "update-validation", validationId: options.validationId }),
            }) + "\n",
            callback,
          );
        if (request.operation === "status") {
          respond(options.isReady() && !busy ? "ready" : "starting");
          return;
        }
        if (request.operation !== "shutdown" || busy || !options.isReady()) {
          respond("unavailable");
          return;
        }
        busy = true;
        let accepted = false;
        try {
          const status = await options.shutdown(abort.signal);
          accepted = status === "accepted";
          if (!abort.signal.aborted)
            respond(status, status === "accepted" ? options.quit : undefined);
        } finally {
          if (!accepted) busy = false;
        }
      })().catch(() => socket.destroy());
    });
  });
  server.maxConnections = 8;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipe, resolve);
  });
  server.on("error", () => {
    for (const socket of sockets) socket.destroy();
  });
  try {
    await writeFile(
      descriptor,
      JSON.stringify({
        schemaVersion: 1,
        sessionId,
        token,
        pipe,
        root,
        version: options.version,
        ...(options.validationId === undefined
          ? {}
          : { mode: "update-validation", validationId: options.validationId }),
      }) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    descriptor,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await unlink(descriptor).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
  };
};
