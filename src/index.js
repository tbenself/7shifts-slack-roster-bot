import { loadDotEnv, readConfig, validateConfig } from "./config.js";
import { createSlackServer } from "./slackServer.js";
import { SevenShiftsClient } from "./sevenShiftsClient.js";

loadDotEnv();

const config = readConfig();
validateConfig(config);

const sevenShiftsClient = new SevenShiftsClient(config.sevenShifts);
const server = createSlackServer({ config, sevenShiftsClient });

server.listen(config.port, () => {
  console.log(`7shifts Slack roster bot listening on port ${config.port}`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
