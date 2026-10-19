// Entry point for `npm start`. Checks the things that otherwise fail with a
// confusing stack trace — Node too old, dependencies not installed — then
// loads the real server.

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 3)) {
  console.error(
    [
      "",
      `✗ Focus Room needs Node.js 20.3 or newer (this is ${process.versions.node}).`,
      "  On Ubuntu, the simplest fix is nvm:",
      "    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash",
      "    source ~/.bashrc && nvm install 22",
      "  (or use the dev container, which already has Node 22).",
      "",
    ].join("\n")
  );
  process.exit(1);
}

try {
  await import("./index.js");
} catch (err) {
  if (err?.code === "ERR_MODULE_NOT_FOUND" && /node_modules|package '/.test(String(err.message)) || /Cannot find package/.test(String(err?.message))) {
    console.error("\n✗ Dependencies aren't installed yet. Run:  npm install\n");
    process.exit(1);
  }
  throw err;
}
