import { MOCK_MODE } from '@gestell/mcp/constants'
import { getMockResponse } from '@gestell/mcp/services/mock-provider'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const DEFAULT_TIMEOUT_MS = 300_000
const MAX_BUFFER_BYTES = 10 * 1024 * 1024

export interface ZoweResult {
  success: boolean;
  stdout: string;
  stderr: string;
  data?: unknown;
  exitCode: number;
}

export function resolveZoweExecutable(
  platform = process.platform,
  commandOverride = process.env.ZOWE_MCP_ZOWE_COMMAND
): string {
  const trimmedOverride = commandOverride?.trim()
  if (trimmedOverride) {
    return trimmedOverride
  }

  return platform === 'win32' ? 'zowe.cmd' : 'zowe'
}

/**
 * Execute a Zowe CLI command and return parsed results.
 * In mock mode, returns realistic canned responses.
 */
export async function executeZowe(command: string, args: string[] = []): Promise<ZoweResult> {
  if (MOCK_MODE) {
    return getMockResponse(command, args)
  }

  try {
    const commandArgs = [...command.trim().split(/\s+/), ...args]
    const timeoutMs = Number(process.env.ZOWE_MCP_EXEC_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
    const zoweExecutable = resolveZoweExecutable()
    const { stdout, stderr } = await executeZoweProcess(
      zoweExecutable,
      commandArgs,
      Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS
    )

    // Try to parse JSON output (Zowe supports --rfj for JSON)
    let data: unknown = undefined
    try {
      data = JSON.parse(stdout)
    } catch {
      // Not JSON, that's fine
    }

    return {
      success: true,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      data,
      exitCode: 0
    }
  } catch (error: unknown) {
    const execError = error as {
      message?: string
      cmd?: string
      signal?: string | null
      killed?: boolean
      stdout?: string | Buffer
      stderr?: string | Buffer
      code?: number
    }
    const stdout = asText(execError.stdout).trim()
    const stderr = asText(execError.stderr).trim()
    const stdoutJson = tryParseJson(stdout)
    const stderrJson = tryParseJson(stderr)

    return {
      success: false,
      stdout,
      stderr: buildErrorMessage({
        stderrText: stderr,
        stdoutText: stdout,
        stdoutJson,
        stderrJson,
        errorMessage: execError.message,
        exitCode: execError.code,
        signal: execError.signal,
        killed: execError.killed,
        cmd: execError.cmd
      }),
      data: stdoutJson || stderrJson,
      exitCode: execError.code || 1
    }
  }
}

async function executeZoweProcess(
  executable: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  if (process.platform !== 'win32') {
    return execFileAsync(executable, args, {
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
      env: { ...process.env }
    })
  }

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: { ...process.env },
      shell: true,
      windowsHide: true
    })

    let stdout = ''
    let stderr = ''
    let finished = false
    let timedOut = false

    const finishWithError = (error: Error): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      reject(error)
    }

    const appendChunk = (current: string, chunk: string, stream: 'stdout' | 'stderr'): string => {
      if (Buffer.byteLength(current) + Buffer.byteLength(chunk) > MAX_BUFFER_BYTES) {
        child.kill()
        finishWithError(Object.assign(new Error(`${stream} exceeded maxBuffer`), {
          stdout,
          stderr,
          killed: true,
          cmd: `${executable} ${args.join(' ')}`
        }))
        return current
      }
      return current + chunk
    }

    child.stdout?.on('data', (chunk: string | Buffer) => {
      stdout = appendChunk(stdout, chunk.toString(), 'stdout')
    })

    child.stderr?.on('data', (chunk: string | Buffer) => {
      stderr = appendChunk(stderr, chunk.toString(), 'stderr')
    })

    child.on('error', (error) => {
      finishWithError(Object.assign(error, {
        stdout,
        stderr,
        cmd: `${executable} ${args.join(' ')}`
      }))
    })

    child.on('close', (code, signal) => {
      if (finished) return
      finished = true
      clearTimeout(timer)

      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }

      const message = timedOut
        ? `Command timed out after ${timeoutMs}ms`
        : `Command failed with exit code ${code ?? 'unknown'}`

      reject(Object.assign(new Error(message), {
        stdout,
        stderr,
        code: code ?? 1,
        signal,
        killed: timedOut,
        cmd: `${executable} ${args.join(' ')}`
      }))
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
  })
}

/**
 * Execute a Zowe CLI command with --rfj (response format JSON) for structured output.
 */
export async function executeZoweJson(command: string, args: string[] = []): Promise<ZoweResult> {
  return executeZowe(command, [...args, '--rfj'])
}

function asText(value?: string | Buffer): string {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return ''
}

function tryParseJson(text: string): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

interface ErrorMessageInput {
  stderrText: string
  stdoutText: string
  stdoutJson: unknown
  stderrJson: unknown
  errorMessage?: string
  exitCode?: number
  signal?: string | null
  killed?: boolean
  cmd?: string
}

function buildErrorMessage(input: ErrorMessageInput): string {
  const {
    stderrText,
    stdoutText,
    stdoutJson,
    stderrJson,
    errorMessage,
    exitCode,
    signal,
    killed,
    cmd
  } = input
  const parts: string[] = []

  if (stderrText) {
    parts.push(stderrText)
  }

  const jsonMessages = [
    ...extractMessages(stdoutJson),
    ...extractMessages(stderrJson)
  ]
  for (const message of jsonMessages) {
    parts.push(message)
  }

  if (!stderrText && !jsonMessages.length && stdoutText) {
    parts.push(stdoutText)
  }

  if (errorMessage) {
    parts.push(errorMessage)
  }

  if (typeof exitCode === 'number') {
    parts.push(`Exit code: ${exitCode}`)
  }
  if (signal) {
    parts.push(`Signal: ${signal}`)
  }
  if (killed) {
    parts.push('Process was killed (likely timeout).')
  }
  if (cmd) {
    parts.push(`CLI command: ${cmd}`)
  }

  if (!stderrText && !stdoutText && !jsonMessages.length) {
    parts.push(
      'No CLI output captured. This often means credentials/prompt/keychain issues in non-interactive sessions.'
    )
    if (process.platform === 'win32') {
      parts.push('On Windows, this can also indicate a CLI launcher/process-spawn problem before Zowe itself started.')
    }
    parts.push(`Runtime env: HOME=${process.env.HOME || '<unset>'}, ZOWE_CLI_HOME=${process.env.ZOWE_CLI_HOME || '<unset>'}`)
  }

  const deduped = Array.from(new Set(parts.map((p) => p.trim()).filter(Boolean)))
  return deduped.join('\n')
}

function extractMessages(value: unknown): string[] {
  const messages: string[] = []
  const seen = new Set<unknown>()
  const keys = ['message', 'msg', 'error', 'details', 'reason', 'stderr', 'stdout']

  const visit = (node: unknown): void => {
    if (!node || seen.has(node)) return
    if (typeof node === 'string') {
      const trimmed = node.trim()
      if (trimmed) messages.push(trimmed)
      return
    }
    if (typeof node !== 'object') return

    seen.add(node)

    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }

    const record = node as Record<string, unknown>
    for (const key of keys) {
      if (key in record) visit(record[key])
    }

    // Some Zowe responses include an array of diagnostics under "messages".
    if ('messages' in record) visit(record.messages)
  }

  visit(value)
  return messages
}
