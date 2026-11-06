/**
 * Local, offline, free text recognition (OCR) for the images posts carry.
 *
 * Two engines, tried in order, and nothing else - no network service, no key,
 * no per-image cost:
 *
 * - **macOS Vision** (`VNRecognizeTextRequest`, accurate level, automatic
 *   language detection), driven through `osascript` with AppleScriptObjC. It
 *   ships with every Mac (no Xcode, no install) and needs no compiled helper:
 *   the script below IS the helper, passed inline with `-e`, so there is no
 *   file to bundle and nothing for macOS privacy prompts to ask about. One
 *   process reads a whole batch of images, which amortizes its ~0.3s start.
 * - **Tesseract** (`tesseract <image> stdout`), when it is on the PATH - the
 *   fallback for Linux, or a Mac where Vision is missing.
 *
 * With neither, {@link detectRecognizer} answers null and the caller marks the
 * images `unavailable` - retried automatically once an engine exists.
 *
 * `run` is the seam: tests inject a fake process runner, so the suite never
 * depends on what the machine has installed (one real test opts in when it can).
 */
import { execFile } from 'node:child_process';

/** What reading one image produced. `text` may be empty: a photo with no words in it. */
export type RecognizeResult = { ok: true; text: string } | { ok: false; error: string };

export interface TextRecognizer {
  /** `vision` or `tesseract` - shown to the owner as where the text came from. */
  readonly id: string;
  /** A human name for the engine, e.g. "macOS Vision". */
  readonly label: string;
  /** Read every image (local file paths), one result per path, in order. Never throws. */
  recognize(paths: string[]): Promise<RecognizeResult[]>;
}

/** Runs a program and resolves with its stdout. Rejects on a non-zero exit or a timeout. */
export type ProcessRunner = (
  file: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<{ stdout: string; stderr: string }>;

export const defaultRunner: ProcessRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr }));
        else resolve({ stdout, stderr });
      },
    );
  });

/** Separates one image's answer from the next in the Vision script's output (ASCII record separator). */
const RECORD_SEPARATOR = '\u001e';

/**
 * The Vision helper. Each argument is an image path; each answer is
 * `OK <text>` or `!ERR <reason>`, joined by {@link RECORD_SEPARATOR}. A
 * failure on one image never stops the others.
 */
export const VISION_SCRIPT = `use AppleScript version "2.7"
use framework "Foundation"
use framework "Vision"
use scripting additions

on run argv
	set out to {}
	repeat with imagePath in argv
		set end of out to my recognize(imagePath as text)
	end repeat
	set AppleScript's text item delimiters to (character id 30)
	return out as text
end run

on recognize(imagePath)
	try
		set theURL to current application's |NSURL|'s fileURLWithPath:imagePath
		set reqHandler to current application's VNImageRequestHandler's alloc()'s initWithURL:theURL options:(current application's NSDictionary's dictionary())
		set request to current application's VNRecognizeTextRequest's alloc()'s init()
		request's setRecognitionLevel:(current application's VNRequestTextRecognitionLevelAccurate)
		request's setUsesLanguageCorrection:true
		try
			request's setAutomaticallyDetectsLanguage:true
		end try
		set {ok, theError} to reqHandler's performRequests:{request} |error|:(reference)
		if not (ok as boolean) then return "!ERR " & ((theError's localizedDescription()) as text)
		set found to {}
		repeat with obs in (request's results() as list)
			set cand to ((obs's topCandidates:1)'s firstObject())
			if cand is not missing value then set end of found to (cand's |string|()) as text
		end repeat
		set AppleScript's text item delimiters to linefeed
		set txt to found as text
		set AppleScript's text item delimiters to ""
		return "OK " & txt
	on error msg
		return "!ERR " & msg
	end try
end recognize`;

/** Whether the Vision text recognizer can be loaded on this Mac. */
const VISION_PROBE = `use framework "Vision"
return (current application's VNRecognizeTextRequest) is not missing value`;

/** Per batch: Vision reads a screenshot in well under a second; this only bounds a hung process. */
const BATCH_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 15_000;

function message(err: unknown): string {
  const stderr = (err as { stderr?: unknown })?.stderr;
  const text = typeof stderr === 'string' && stderr.trim() ? stderr.trim() : err instanceof Error ? err.message : String(err);
  return text.split('\n')[0]!.slice(0, 300);
}

/** Parse the Vision script's output into one result per requested image. */
export function parseVisionOutput(stdout: string, count: number): RecognizeResult[] {
  // osascript appends one newline to whatever the script returns.
  const body = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
  const records = count === 0 ? [] : body.split(RECORD_SEPARATOR);
  const results: RecognizeResult[] = [];
  for (let i = 0; i < count; i++) {
    const record = records[i];
    if (record === undefined) results.push({ ok: false, error: 'The text recognizer returned no answer for this image.' });
    else if (record.startsWith('OK')) results.push({ ok: true, text: record.slice(3).trim() });
    else results.push({ ok: false, error: record.replace(/^!ERR\s*/, '').trim() || 'The text recognizer failed.' });
  }
  return results;
}

export class VisionRecognizer implements TextRecognizer {
  readonly id = 'vision';
  readonly label = 'macOS Vision';

  constructor(private readonly run: ProcessRunner = defaultRunner) {}

  async recognize(paths: string[]): Promise<RecognizeResult[]> {
    if (paths.length === 0) return [];
    try {
      const { stdout } = await this.run('osascript', ['-e', VISION_SCRIPT, ...paths], { timeoutMs: BATCH_TIMEOUT_MS });
      return parseVisionOutput(stdout, paths.length);
    } catch (err) {
      const error = `macOS text recognition failed: ${message(err)}`;
      return paths.map(() => ({ ok: false, error }));
    }
  }
}

export class TesseractRecognizer implements TextRecognizer {
  readonly id = 'tesseract';
  readonly label = 'Tesseract';

  constructor(private readonly run: ProcessRunner = defaultRunner) {}

  async recognize(paths: string[]): Promise<RecognizeResult[]> {
    const results: RecognizeResult[] = [];
    for (const imagePath of paths) {
      try {
        const { stdout } = await this.run('tesseract', [imagePath, 'stdout'], { timeoutMs: BATCH_TIMEOUT_MS });
        results.push({ ok: true, text: stdout.trim() });
      } catch (err) {
        results.push({ ok: false, error: `Tesseract failed: ${message(err)}` });
      }
    }
    return results;
  }
}

export interface DetectOptions {
  run?: ProcessRunner;
  platform?: NodeJS.Platform;
}

/**
 * The best engine this machine has: Vision on a Mac where it loads, else
 * Tesseract when it runs, else null. Probing spawns a process, so callers
 * detect once and keep the answer (see `ImageTextWorker`).
 */
export async function detectRecognizer(options: DetectOptions = {}): Promise<TextRecognizer | null> {
  const run = options.run ?? defaultRunner;
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') {
    try {
      const { stdout } = await run('osascript', ['-e', VISION_PROBE], { timeoutMs: PROBE_TIMEOUT_MS });
      if (stdout.trim() === 'true') return new VisionRecognizer(run);
    } catch {
      // No Vision (or no osascript) - try Tesseract.
    }
  }
  try {
    await run('tesseract', ['--version'], { timeoutMs: PROBE_TIMEOUT_MS });
    return new TesseractRecognizer(run);
  } catch {
    return null;
  }
}

/** Why images are not being read, when {@link detectRecognizer} found nothing. */
export const NO_RECOGNIZER_MESSAGE =
  'No text recognizer on this computer: macOS Vision is unavailable and Tesseract is not installed ' +
  '(e.g. `brew install tesseract` or `apt install tesseract-ocr`). Images are read once one is.';
