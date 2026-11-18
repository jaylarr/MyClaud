import { spawn, type ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import { app, shell } from 'electron'
import { mkdir, readdir, readFile, stat, unlink } from 'fs/promises'
import { createServer, type Server } from 'http'
import { homedir } from 'os'
import { delimiter, join } from 'path'
import type {
  CliProviderId,
  ProviderAccountInfo,
  ProviderActionResult,
  ProviderStatus,
  ProvidersStatusResult
} from '../shared/ipc'
import { getChatChoice, setChatChoice } from './chats'
import { isObject, readJsonFile, serialQueue, writeJsonFile } from './jsonFile'
import { AUTO } from '../shared/models'
import { getDefaultChoice, getProject, setDefaultChoice } from './settings'

type StoredAuth = {
  codexApiKey: string | null
  geminiApiKey: string | null
}

const EMPTY_AUTH: StoredAuth = {
  codexApiKey: null,
  geminiApiKey: null
}

// OAuth2 scopes and redirect targets used by @google/gemini-cli (code_assist/oauth2.js).
// Client credentials are read from the locally installed @google/gemini-cli bundle at runtime
// rather than hardcoded in source control.
const GEMINI_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
]
const GEMINI_SIGN_IN_SUCCESS_URL =
  'https://developers.google.com/gemini-code-assist/auth_success_gemini'
const GEMINI_SIGN_IN_FAILURE_URL =
  'https://developers.google.com/gemini-code-assist/auth_failure_gemini'

async function resolveGeminiOAuthClient(): Promise<{
  clientId: string
  clientSecret: string
} | null> {
  const npmRootRes = await runQuickCommand('npm', ['root', '-g'], 4_000)
  const roots = [
    ...(npmRootRes.ok && npmRootRes.stdout ? [npmRootRes.stdout.split(/\r?\n/)[0].trim()] : []),
    ...(process.platform === 'win32' && process.env['APPDATA']
      ? [join(process.env['APPDATA'], 'npm', 'node_modules')]
      : ['/usr/local/lib/node_modules', '/opt/homebrew/lib/node_modules'])
  ]
  for (const root of roots) {
    const bundleDir = join(root, '@google', 'gemini-cli', 'bundle')
    let entries: string[]
    try {
      entries = await readdir(bundleDir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.startsWith('chunk-') || !entry.endsWith('.js')) continue
      try {
        const text = await readFile(join(bundleDir, entry), 'utf8')
        const idMatch = /OAUTH_CLIENT_ID\s*=\s*"([^"]+\.apps\.googleusercontent\.com)"/.exec(text)
        const secMatch = /OAUTH_CLIENT_SECRET\s*=\s*"([^"]+)"/.exec(text)
        if (idMatch && secMatch) {
          return { clientId: idMatch[1], clientSecret: secMatch[1] }
        }
      } catch {
        // Ignore unreadable chunk
      }
    }
  }
  return null
}

const authQueue = serialQueue()
let cachedAuth: StoredAuth | null = null
let sessionStatusCache: ProvidersStatusResult | null = null
let pendingStatusPromise: Promise<ProvidersStatusResult> | null = null

const activeCancelFns = new Map<CliProviderId, () => void>()

function authStorePath(): string {
  return join(app.getPath('userData'), 'provider-auth.json')
}

function codexAuthPath(): string {
  return join(homedir(), '.codex', 'auth.json')
}

function geminiDir(): string {
  return join(homedir(), '.gemini')
}

function geminiSettingsPath(): string {
  return join(geminiDir(), 'settings.json')
}

function geminiOauthCredsPath(): string {
  return join(geminiDir(), 'oauth_creds.json')
}

function geminiAccountsPath(): string {
  return join(geminiDir(), 'google_accounts.json')
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function maskSecret(secret: string): string {
  const trimmed = secret.trim()
  if (trimmed.length <= 8) return '••••••••'
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`
}

function decodeJwtPayload(token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8')
    const parsed: unknown = JSON.parse(json)
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function formatPlanName(rawPlan: string | null): string | null {
  if (!rawPlan) return null
  const lower = rawPlan.toLowerCase()
  if (lower === 'plus') return 'ChatGPT Plus'
  if (lower === 'pro') return 'ChatGPT Pro'
  if (lower === 'team') return 'ChatGPT Team'
  if (lower === 'enterprise') return 'ChatGPT Enterprise'
  if (lower === 'free') return 'ChatGPT Free'
  return `ChatGPT (${rawPlan.toUpperCase()})`
}

function formatIsoDate(rawIso: string | null): string | null {
  if (!rawIso) return null
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(rawIso)
  return match ? match[1] : null
}

// Ensures global npm and Antigravity CLI (agy) binary directories on Windows/macOS/Linux
// are on PATH even if installed after launching Electron.
export function augmentedEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  const additions: string[] = []
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA']
    if (appData) additions.push(join(appData, 'npm'))
    const localAppData = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local')
    additions.push(join(localAppData, 'agy', 'bin'))
  } else {
    additions.push(
      '/usr/local/bin',
      '/opt/homebrew/bin',
      join(homedir(), '.npm-global', 'bin'),
      join(homedir(), '.local', 'bin'),
      join(homedir(), '.agy', 'bin')
    )
  }
  const currentPath = env.PATH ?? env.Path ?? ''
  const merged = [...additions, currentPath].filter(Boolean).join(delimiter)
  env.PATH = merged
  if ('Path' in env) env.Path = merged
  return env
}

export async function resolveAgyBinary(): Promise<string | null> {
  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local')
    const candidate = join(localAppData, 'agy', 'bin', 'agy.exe')
    try {
      await stat(candidate)
      return candidate
    } catch {
      // Fall through to PATH check
    }
  } else {
    for (const candidate of [
      join(homedir(), '.local', 'bin', 'agy'),
      join(homedir(), '.agy', 'bin', 'agy'),
      '/usr/local/bin/agy'
    ]) {
      try {
        await stat(candidate)
        return candidate
      } catch {
        // Continue checking
      }
    }
  }
  const res = await runQuickCommand('agy', ['--help'], 5_000)
  return res.ok ? 'agy' : null
}

export async function shouldUseAgyForGemini(): Promise<{ useAgy: boolean; agyBinary: string }> {
  const stored = await loadStoredAuth()
  if (stored.geminiApiKey) {
    return { useAgy: false, agyBinary: 'gemini' }
  }
  const agyBin = await resolveAgyBinary()
  if (agyBin) {
    return { useAgy: true, agyBinary: agyBin }
  }
  return { useAgy: false, agyBinary: 'gemini' }
}

async function loadStoredAuth(): Promise<StoredAuth> {
  if (cachedAuth) return cachedAuth
  try {
    const raw = await readJsonFile(authStorePath())
    if (isObject(raw)) {
      cachedAuth = {
        codexApiKey: nonEmptyString(raw.codexApiKey),
        geminiApiKey: nonEmptyString(raw.geminiApiKey)
      }
      return cachedAuth
    }
  } catch (err) {
    console.error('[providerAuth] Could not read provider-auth.json:', err)
  }
  cachedAuth = { ...EMPTY_AUTH }
  return cachedAuth
}

async function updateStoredAuth(
  change: (current: StoredAuth) => StoredAuth
): Promise<StoredAuth> {
  return authQueue(async () => {
    const before = await loadStoredAuth()
    const after = change(before)
    cachedAuth = after
    await writeJsonFile(authStorePath(), {
      version: 1,
      ...(after.codexApiKey ? { codexApiKey: after.codexApiKey } : {}),
      ...(after.geminiApiKey ? { geminiApiKey: after.geminiApiKey } : {})
    })
    return after
  })
}

// Returns environment variables (including stored API keys and augmented PATH) for
// cliProviders.ts when spawning codex or gemini.
export async function providerChildEnv(provider: CliProviderId): Promise<NodeJS.ProcessEnv> {
  const stored = await loadStoredAuth()
  const extra: Record<string, string | undefined> = {}
  if (provider === 'codex' && stored.codexApiKey) {
    extra.OPENAI_API_KEY = stored.codexApiKey
    extra.CODEX_API_KEY = stored.codexApiKey
  }
  if (provider === 'gemini') {
    if (stored.geminiApiKey) {
      extra.GEMINI_API_KEY = stored.geminiApiKey
    } else {
      // Tells @google/gemini-cli in headless/non-interactive mode to use cached Google OAuth.
      extra.GOOGLE_GENAI_USE_GCA = 'true'
    }
  }
  return augmentedEnv(extra)
}

function killProcessTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      return
    } catch {
      // Fall back to child.kill()
    }
  }
  try {
    child.kill()
  } catch {
    // Ignore if already exited
  }
}

function runQuickCommand(
  binary: string,
  args: string[],
  timeoutMs = 8_000,
  stdinText?: string
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, stdout: stdout.trim(), stderr: stderr.trim() })
    }

    const child = spawn(binary, args, {
      env: augmentedEnv(),
      shell: process.platform === 'win32',
      windowsHide: true
    })

    const timer = setTimeout(() => {
      killProcessTree(child)
      finish(false)
    }, timeoutMs)

    if (child.stdin) {
      child.stdin.on('error', () => {})
      if (stdinText !== undefined) {
        child.stdin.end(stdinText, 'utf8')
      } else {
        child.stdin.end()
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', () => finish(false))
    child.on('close', (code) => finish(code === 0))
  })
}

async function detectCliVersion(
  binary: string
): Promise<{ installed: boolean; version: string | null }> {
  const res = await runQuickCommand(binary, ['--version'], 6_000)
  if (!res.ok) return { installed: false, version: null }
  const firstLine = (res.stdout || res.stderr).split(/\r?\n/)[0]?.trim() ?? ''
  return { installed: true, version: firstLine || null }
}

async function fileMtimeMs(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return null
  }
}

async function hasCodexOauthFile(): Promise<{
  ok: boolean
  detail: string | null
  account: ProviderAccountInfo | null
}> {
  try {
    const raw = await readJsonFile(codexAuthPath())
    if (!isObject(raw)) return { ok: false, detail: null, account: null }
    const fileKey = nonEmptyString(raw.OPENAI_API_KEY)
    if (fileKey) {
      return {
        ok: true,
        detail: `API Key (${maskSecret(fileKey)})`,
        account: {
          name: null,
          email: null,
          plan: 'OpenAI API (Pay-as-you-go)',
          organization: null,
          activeUntil: null
        }
      }
    }
    if (isObject(raw.tokens)) {
      const hasToken =
        nonEmptyString(raw.tokens.access_token) !== null ||
        nonEmptyString(raw.tokens.refresh_token) !== null ||
        nonEmptyString(raw.tokens.id_token) !== null
      if (hasToken) {
        const idClaims = decodeJwtPayload(raw.tokens.id_token)
        const accessClaims = decodeJwtPayload(raw.tokens.access_token)
        const profileClaims =
          accessClaims && isObject(accessClaims['https://api.openai.com/profile'])
            ? accessClaims['https://api.openai.com/profile']
            : null
        const idAuthClaims =
          idClaims && isObject(idClaims['https://api.openai.com/auth'])
            ? idClaims['https://api.openai.com/auth']
            : null
        const accessAuthClaims =
          accessClaims && isObject(accessClaims['https://api.openai.com/auth'])
            ? accessClaims['https://api.openai.com/auth']
            : null

        const name =
          nonEmptyString(idClaims?.name) ?? nonEmptyString(profileClaims?.name) ?? null
        const email =
          nonEmptyString(idClaims?.email) ?? nonEmptyString(profileClaims?.email) ?? null
        const rawPlan =
          nonEmptyString(idAuthClaims?.chatgpt_plan_type) ??
          nonEmptyString(accessAuthClaims?.chatgpt_plan_type) ??
          null
        const plan = formatPlanName(rawPlan) ?? 'ChatGPT Subscription'
        const activeUntil = formatIsoDate(
          nonEmptyString(idAuthClaims?.chatgpt_subscription_active_until)
        )

        let organization: string | null = null
        if (Array.isArray(idAuthClaims?.organizations) && idAuthClaims.organizations.length > 0) {
          const orgs = idAuthClaims.organizations.filter(isObject)
          const chosen = orgs.find((o) => o.is_default === true) ?? orgs[0]
          if (chosen) {
            const title = nonEmptyString(chosen.title)
            const role = nonEmptyString(chosen.role)
            if (title && role) organization = `${title} (${role})`
            else organization = title ?? role
          }
        }

        return {
          ok: true,
          detail: 'ChatGPT Account (Browser OAuth)',
          account: {
            name,
            email,
            plan,
            organization,
            activeUntil
          }
        }
      }
    }
  } catch {
    // Ignore missing or unreadable file
  }
  return { ok: false, detail: null, account: null }
}

async function hasGeminiOauthFile(): Promise<{
  ok: boolean
  detail: string | null
  account: ProviderAccountInfo | null
}> {
  try {
    const raw = await readJsonFile(geminiOauthCredsPath())
    if (!isObject(raw)) return { ok: false, detail: null, account: null }
    const hasToken =
      nonEmptyString(raw.refresh_token) !== null || nonEmptyString(raw.access_token) !== null
    if (!hasToken) return { ok: false, detail: null, account: null }

    const accounts = await readJsonFile(geminiAccountsPath()).catch(() => undefined)
    const activeAccount = isObject(accounts) ? nonEmptyString(accounts.active) : null
    const idClaims = decodeJwtPayload(raw.id_token)
    const name = nonEmptyString(idClaims?.name) ?? null
    const email = activeAccount ?? nonEmptyString(idClaims?.email) ?? null
    const domain = nonEmptyString(idClaims?.hd) ?? null
    const expiryMs = typeof raw.expiry_date === 'number' ? raw.expiry_date : null
    const activeUntil =
      expiryMs && Number.isFinite(expiryMs)
        ? new Date(expiryMs).toISOString().slice(0, 10)
        : null

    return {
      ok: true,
      detail: 'Google Account (OAuth · Antigravity CLI)',
      account: {
        name,
        email,
        plan: domain ? 'Google AI Pro / Workspace' : 'Google AI Pro (Subscription)',
        organization: domain,
        activeUntil
      }
    }
  } catch {
    return { ok: false, detail: null, account: null }
  }
}

async function getCodexStatus(stored: StoredAuth): Promise<ProviderStatus> {
  const cli = await detectCliVersion('codex')
  if (stored.codexApiKey) {
    return {
      provider: 'codex',
      installed: cli.installed,
      version: cli.version,
      loggedIn: true,
      method: 'api_key',
      detail: `Saved API Key (${maskSecret(stored.codexApiKey)})`,
      account: {
        name: null,
        email: null,
        plan: 'OpenAI API Key (Pay-as-you-go)',
        organization: null,
        activeUntil: null
      }
    }
  }
  const oauthFile = await hasCodexOauthFile()
  if (oauthFile.ok) {
    return {
      provider: 'codex',
      installed: cli.installed,
      version: cli.version,
      loggedIn: true,
      method: oauthFile.detail?.startsWith('API Key') ? 'api_key' : 'oauth',
      detail: oauthFile.detail,
      account: oauthFile.account
    }
  }
  const envKey = nonEmptyString(process.env.OPENAI_API_KEY ?? process.env.CODEX_API_KEY)
  if (envKey) {
    return {
      provider: 'codex',
      installed: cli.installed,
      version: cli.version,
      loggedIn: true,
      method: 'env',
      detail: `Environment key (${maskSecret(envKey)})`,
      account: {
        name: null,
        email: null,
        plan: 'OpenAI API Key (Environment)',
        organization: null,
        activeUntil: null
      }
    }
  }
  return {
    provider: 'codex',
    installed: cli.installed,
    version: cli.version,
    loggedIn: false,
    method: null,
    detail: null,
    account: null
  }
}

async function getGeminiStatus(stored: StoredAuth): Promise<ProviderStatus> {
  const [cli, agyBin] = await Promise.all([detectCliVersion('gemini'), resolveAgyBinary()])
  const installed = agyBin !== null || cli.installed
  const version = agyBin
    ? cli.version
      ? `agy + gemini-cli ${cli.version}`
      : 'agy (Antigravity CLI)'
    : cli.version
  if (stored.geminiApiKey) {
    return {
      provider: 'gemini',
      installed,
      version,
      loggedIn: true,
      method: 'api_key',
      detail: `Saved API Key (${maskSecret(stored.geminiApiKey)})`,
      account: {
        name: null,
        email: null,
        plan: 'Google AI Studio (API Key)',
        organization: null,
        activeUntil: null
      }
    }
  }
  const oauthFile = await hasGeminiOauthFile()
  if (oauthFile.ok) {
    return {
      provider: 'gemini',
      installed,
      version,
      loggedIn: true,
      method: 'oauth',
      detail: oauthFile.detail,
      account: oauthFile.account
    }
  }
  if (agyBin) {
    return {
      provider: 'gemini',
      installed: true,
      version,
      loggedIn: true,
      method: 'oauth',
      detail: 'Google Account (Antigravity CLI)',
      account: {
        name: null,
        email: null,
        plan: 'Google AI Pro (Antigravity CLI)',
        organization: null,
        activeUntil: null
      }
    }
  }
  const envKey = nonEmptyString(process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY)
  if (envKey) {
    return {
      provider: 'gemini',
      installed,
      version,
      loggedIn: true,
      method: 'env',
      detail: `Environment key (${maskSecret(envKey)})`,
      account: {
        name: null,
        email: null,
        plan: 'Gemini API Key (Environment)',
        organization: null,
        activeUntil: null
      }
    }
  }
  return {
    provider: 'gemini',
    installed,
    version,
    loggedIn: false,
    method: null,
    detail: null,
    account: null
  }
}

export async function getProvidersStatus(force = false): Promise<ProvidersStatusResult> {
  if (!force && sessionStatusCache !== null) {
    return sessionStatusCache
  }
  if (!force && pendingStatusPromise !== null) {
    return pendingStatusPromise
  }
  const run = (async (): Promise<ProvidersStatusResult> => {
    const stored = await loadStoredAuth()
    const [codex, gemini] = await Promise.all([getCodexStatus(stored), getGeminiStatus(stored)])
    const result: ProvidersStatusResult = { codex, gemini }
    sessionStatusCache = result
    return result
  })()
  pendingStatusPromise = run
  try {
    return await run
  } finally {
    if (pendingStatusPromise === run) {
      pendingStatusPromise = null
    }
  }
}

async function activateProviderModelIfAuto(provider: CliProviderId): Promise<void> {
  const targetModel = provider === 'codex' ? 'codex:gpt-5.3-codex' : 'gemini:gemini-2.5-pro'
  try {
    const def = await getDefaultChoice()
    if (def.model === AUTO) {
      await setDefaultChoice({ model: targetModel, effort: AUTO })
    }
    const project = getProject()
    if (project) {
      const chat = await getChatChoice(project.path)
      if (!chat || chat.model === AUTO) {
        await setChatChoice(project.path, { model: targetModel, effort: AUTO })
      }
    }
  } catch (err) {
    console.error('[providerAuth] Could not auto-select provider model:', err)
  }
}

async function setGeminiAuthType(authType: 'oauth-personal' | 'gemini-api-key'): Promise<void> {
  try {
    await mkdir(geminiDir(), { recursive: true })
    const existing = await readJsonFile(geminiSettingsPath()).catch(() => undefined)
    const base = isObject(existing) ? existing : {}
    const security = isObject(base.security) ? base.security : {}
    const auth = isObject(security.auth) ? security.auth : {}
    const next = {
      ...base,
      selectedAuthType: authType,
      security: {
        ...security,
        auth: {
          ...auth,
          selectedType: authType
        }
      }
    }
    await writeJsonFile(geminiSettingsPath(), next)
  } catch (err) {
    console.error('[providerAuth] Could not write ~/.gemini/settings.json:', err)
  }
}

export function cancelProviderLogin(provider: CliProviderId): { ok: boolean } {
  const cancel = activeCancelFns.get(provider)
  if (!cancel) return { ok: false }
  activeCancelFns.delete(provider)
  cancel()
  return { ok: true }
}

async function loginCodexOAuth(): Promise<ProviderActionResult> {
  const cli = await detectCliVersion('codex')
  if (!cli.installed) {
    return {
      ok: false,
      error: 'OpenAI Codex CLI is not installed yet. Click INSTALL CLI first.',
      status: await getProvidersStatus()
    }
  }

  const beforeMtime = await fileMtimeMs(codexAuthPath())
  const wasLoggedIn = (await hasCodexOauthFile()).ok

  // Set BROWSER=echo so codex prints the OAuth URL immediately without failing inside a
  // hidden child console, and we open it directly in the active browser via shell.openExternal.
  const env = augmentedEnv({
    OPENAI_API_KEY: undefined,
    CODEX_API_KEY: undefined,
    BROWSER: 'echo'
  })
  delete env.OPENAI_API_KEY
  delete env.CODEX_API_KEY

  const loginOutcome = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    let settled = false
    let openedUrl = false
    let cancelled = false
    let outputText = ''

    const finish = (result: { ok: boolean; error?: string }): void => {
      if (settled) return
      settled = true
      clearInterval(poller)
      clearTimeout(timeout)
      activeCancelFns.delete('codex')
      resolve(result)
    }

    const child = spawn('codex', ['login'], {
      env,
      shell: process.platform === 'win32',
      windowsHide: true
    })

    activeCancelFns.set('codex', () => {
      cancelled = true
      killProcessTree(child)
      finish({ ok: false, error: 'Sign-in was cancelled.' })
    })

    const inspectChunk = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      outputText += text
      if (!openedUrl) {
        const match = /https:\/\/auth\.openai\.com\/[^\s"'<>]+/.exec(outputText)
        if (match) {
          openedUrl = true
          // Add prompt=login when switching accounts so the active browser prompts for
          // credentials instead of silently reusing the existing session.
          const sep = match[0].includes('?') ? '&' : '?'
          const authUrl =
            wasLoggedIn && !match[0].includes('prompt=')
              ? `${match[0]}${sep}prompt=login`
              : match[0]
          void shell.openExternal(authUrl)
        }
      }
    }

    child.stdout?.on('data', inspectChunk)
    child.stderr?.on('data', inspectChunk)

    // Only treat auth.json as completed when its mtime is newer than beforeMtime.
    const poller = setInterval(() => {
      void (async () => {
        const nowMtime = await fileMtimeMs(codexAuthPath())
        if (nowMtime !== null && (beforeMtime === null || nowMtime > beforeMtime + 100)) {
          const check = await hasCodexOauthFile()
          if (check.ok) {
            await updateStoredAuth((cur) => ({ ...cur, codexApiKey: null }))
            killProcessTree(child)
            finish({ ok: true })
          }
        }
      })()
    }, 1_000)

    const timeout = setTimeout(() => {
      killProcessTree(child)
      finish({ ok: false, error: 'Browser sign-in timed out after 3 minutes.' })
    }, 180_000)

    child.on('error', (err) => {
      finish({ ok: false, error: err.message })
    })

    child.on('close', (code) => {
      void (async () => {
        if (cancelled) {
          finish({ ok: false, error: 'Sign-in was cancelled.' })
          return
        }
        const nowMtime = await fileMtimeMs(codexAuthPath())
        const updated = nowMtime !== null && (beforeMtime === null || nowMtime > beforeMtime + 100)
        const check = await hasCodexOauthFile()
        if ((code === 0 || updated) && check.ok) {
          await updateStoredAuth((cur) => ({ ...cur, codexApiKey: null }))
          finish({ ok: true })
        } else {
          const cleanErr = outputText.trim().split(/\r?\n/).slice(-3).join(' ')
          finish({
            ok: false,
            error: cleanErr || `Browser sign-in did not complete (exit code ${code ?? 'unknown'}).`
          })
        }
      })()
    })
  })

  const status = await getProvidersStatus(true)
  if (loginOutcome.ok && status.codex.loggedIn) {
    await activateProviderModelIfAuto('codex')
    return { ok: true, status }
  }
  return {
    ok: false,
    error: loginOutcome.error ?? 'Sign-in was not completed.',
    status
  }
}

async function loginGeminiOAuth(): Promise<ProviderActionResult> {
  const oauthClient = await resolveGeminiOAuthClient()
  if (!oauthClient) {
    return {
      ok: false,
      error:
        'Google Gemini CLI bundle was not found. Install @google/gemini-cli, use Antigravity CLI (agy), or paste a Gemini API key.',
      status: await getProvidersStatus()
    }
  }
  const state = randomBytes(32).toString('hex')

  const loginOutcome = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    let settled = false
    let server: Server | null = null

    const finish = (result: { ok: boolean; error?: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      activeCancelFns.delete('gemini')
      try {
        server?.close()
      } catch {
        // Ignore
      }
      resolve(result)
    }

    const timeout = setTimeout(() => {
      finish({ ok: false, error: 'Browser sign-in timed out after 3 minutes.' })
    }, 180_000)

    activeCancelFns.set('gemini', () => {
      finish({ ok: false, error: 'Sign-in was cancelled.' })
    })

    server = createServer((req, res) => {
      void (async () => {
        try {
          const reqUrl = req.url ?? '/'
          if (!reqUrl.includes('/oauth2callback')) {
            res.writeHead(301, { Location: GEMINI_SIGN_IN_FAILURE_URL })
            res.end()
            return
          }
          const parsedUrl = new URL(reqUrl, 'http://127.0.0.1')
          const errorParam = parsedUrl.searchParams.get('error')
          if (errorParam) {
            res.writeHead(301, { Location: GEMINI_SIGN_IN_FAILURE_URL })
            res.end()
            finish({ ok: false, error: `Google OAuth error: ${errorParam}` })
            return
          }
          if (parsedUrl.searchParams.get('state') !== state) {
            res.writeHead(400)
            res.end('State mismatch.')
            finish({ ok: false, error: 'OAuth state mismatch.' })
            return
          }
          const code = parsedUrl.searchParams.get('code')
          const addr = server?.address()
          const port = addr && typeof addr === 'object' ? addr.port : 0
          const redirectUri = `http://127.0.0.1:${port}/oauth2callback`
          if (!code || !port) {
            res.writeHead(301, { Location: GEMINI_SIGN_IN_FAILURE_URL })
            res.end()
            finish({ ok: false, error: 'No authorization code received from Google.' })
            return
          }

          const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: oauthClient.clientId,
              client_secret: oauthClient.clientSecret,
              code,
              grant_type: 'authorization_code',
              redirect_uri: redirectUri
            }).toString()
          })

          if (!tokenRes.ok) {
            res.writeHead(301, { Location: GEMINI_SIGN_IN_FAILURE_URL })
            res.end()
            finish({
              ok: false,
              error: `Token exchange failed (${tokenRes.status} ${tokenRes.statusText}).`
            })
            return
          }

          const tokens = (await tokenRes.json()) as Record<string, unknown>
          const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : 3600
          const credsToSave: Record<string, unknown> = {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            scope: tokens.scope,
            token_type: tokens.token_type ?? 'Bearer',
            id_token: tokens.id_token,
            expiry_date: Date.now() + expiresIn * 1000
          }

          await mkdir(geminiDir(), { recursive: true })
          await writeJsonFile(geminiOauthCredsPath(), credsToSave)

          // Fetch Google account email and cache it in google_accounts.json.
          if (typeof tokens.access_token === 'string') {
            try {
              const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                headers: { Authorization: `Bearer ${tokens.access_token}` }
              })
              if (infoRes.ok) {
                const info = (await infoRes.json()) as Record<string, unknown>
                if (typeof info.email === 'string' && info.email.trim() !== '') {
                  await writeJsonFile(geminiAccountsPath(), {
                    active: info.email.trim(),
                    old: []
                  })
                }
              }
            } catch {
              // Non-fatal: id_token also carries email/name
            }
          }

          await updateStoredAuth((cur) => ({ ...cur, geminiApiKey: null }))
          await setGeminiAuthType('oauth-personal')

          res.writeHead(301, { Location: GEMINI_SIGN_IN_SUCCESS_URL })
          res.end()
          finish({ ok: true })
        } catch (err) {
          finish({
            ok: false,
            error: err instanceof Error ? err.message : 'Google OAuth sign-in failed.'
          })
        }
      })()
    })

    server.on('error', (err) => {
      finish({ ok: false, error: `Could not start local OAuth server: ${err.message}` })
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server?.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      if (!port) {
        finish({ ok: false, error: 'Could not bind local OAuth callback port.' })
        return
      }
      const redirectUri = `http://127.0.0.1:${port}/oauth2callback`
      const params = new URLSearchParams({
        client_id: oauthClient.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        access_type: 'offline',
        prompt: 'select_account consent',
        scope: GEMINI_OAUTH_SCOPES.join(' '),
        state
      })
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
      void shell.openExternal(authUrl)
    })
  })

  const status = await getProvidersStatus(true)
  if (loginOutcome.ok && status.gemini.loggedIn) {
    await activateProviderModelIfAuto('gemini')
    return { ok: true, status }
  }
  return {
    ok: false,
    error: loginOutcome.error ?? 'Sign-in was not completed.',
    status
  }
}

export async function loginProviderOAuth(provider: CliProviderId): Promise<ProviderActionResult> {
  cancelProviderLogin(provider)
  if (provider === 'codex') {
    return loginCodexOAuth()
  }
  return loginGeminiOAuth()
}

export async function saveProviderApiKey(
  provider: CliProviderId,
  rawKey: string
): Promise<ProviderActionResult> {
  const trimmed = typeof rawKey === 'string' ? rawKey.trim() : ''
  if (trimmed === '') {
    return {
      ok: false,
      error: 'Enter a non-empty API key.',
      status: await getProvidersStatus()
    }
  }
  if (/[\r\n]/.test(trimmed)) {
    return {
      ok: false,
      error: 'API key cannot contain line breaks.',
      status: await getProvidersStatus()
    }
  }

  if (provider === 'codex') {
    await updateStoredAuth((cur) => ({ ...cur, codexApiKey: trimmed }))
    const cli = await detectCliVersion('codex')
    if (cli.installed) {
      await runQuickCommand('codex', ['login', '--with-api-key'], 10_000, `${trimmed}\n`)
    }
    await activateProviderModelIfAuto('codex')
  } else {
    await updateStoredAuth((cur) => ({ ...cur, geminiApiKey: trimmed }))
    await setGeminiAuthType('gemini-api-key')
    await activateProviderModelIfAuto('gemini')
  }

  return { ok: true, status: await getProvidersStatus(true) }
}

export async function logoutProvider(provider: CliProviderId): Promise<ProviderActionResult> {
  cancelProviderLogin(provider)
  if (provider === 'codex') {
    await updateStoredAuth((cur) => ({ ...cur, codexApiKey: null }))
    await runQuickCommand('codex', ['logout'], 6_000).catch(() => {})
    await unlink(codexAuthPath()).catch(() => {})
  } else {
    await updateStoredAuth((cur) => ({ ...cur, geminiApiKey: null }))
    await unlink(geminiOauthCredsPath()).catch(() => {})
    await unlink(geminiAccountsPath()).catch(() => {})
  }
  return { ok: true, status: await getProvidersStatus(true) }
}

export async function installProviderCli(provider: CliProviderId): Promise<ProviderActionResult> {
  const pkg = provider === 'codex' ? '@openai/codex' : '@google/gemini-cli'
  const res = await runQuickCommand('npm', ['install', '-g', pkg], 180_000)
  const status = await getProvidersStatus(true)
  const installed = provider === 'codex' ? status.codex.installed : status.gemini.installed
  if (!res.ok || !installed) {
    const detail = (res.stderr || res.stdout).split(/\r?\n/).slice(-3).join(' ')
    return {
      ok: false,
      error: detail || `Could not install ${pkg} via npm.`,
      status
    }
  }
  return { ok: true, status }
}
