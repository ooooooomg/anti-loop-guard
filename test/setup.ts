/**
 * Test setup: point state persistence at a temp directory so tests never
 * write to the real ~/.anti-loop-guard/ on the dev machine.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anti-loop-guard-test-"));
process.env.ANTI_LOOP_STATE_DIR = dir;
