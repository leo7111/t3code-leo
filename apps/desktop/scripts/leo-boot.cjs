const path = require("node:path");
const os = require("node:os");

process.env.T3CODE_HOME = path.join(os.homedir(), ".t3-transcription-preview");
process.env.APPDATA = path.join(process.env.T3CODE_HOME, "desktop-profile");
process.env.T3CODE_DESKTOP_APP_USER_MODEL_ID = "com.leo7111.t3code.transcription.preview";
process.env.T3CODE_DISABLE_AUTO_UPDATE = "1";
process.env.T3CODE_DESKTOP_DISPLAY_NAME = "T3 Code Leo";
for (const name of [
  "VITE_DEV_SERVER_URL",
  "VITE_HTTP_URL",
  "VITE_WS_URL",
  "T3CODE_PORT",
  "T3_SERVICE_LAUNCHER_CONTEXT",
  "T3_BOOT_SERVICE_UNIT",
]) {
  delete process.env[name];
}
require("./boot.cjs");
