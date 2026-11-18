import { homedir } from 'os'
import { join } from 'path'
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  EFFORT_LEVELS,
  modelLists,
  type EffortLevel,
  type ModelLists,
  type ModelOption
} from '../shared/models'
import { isObject, readJsonFile } from './jsonFile'
import { createInputQueue } from './runInput'
import { childEnv, claudeExecutable, loadSdk } from './sdk'

// The models the logged-in account can use, from the SDK's supportedModels(). It
// belongs to a query, so a query is opened with no message in it: Claude Code
// answers from its start-up information, nothing is sent to a model, and nothing
// is used from the plan. The query is closed at once.
//
// The list is fetched once per project folder and kept: the folder's own settings
// can narrow it. A failed fetch is not kept, so the next ask tries again.

const FETCH_TIMEOUT_MS = 30_000

export type ModelsLoad = { ok: true; lists: ModelLists } | { ok: false; message: string }

const cache = new Map<string, Promise<ModelsLoad>>()

async function loadCodexCachedModels(): Promise<ModelOption[]> {
  const raw = await readJsonFile(join(homedir(), '.codex', 'models_cache.json'))
  if (!isObject(raw) || !Array.isArray(raw.models)) return []
  const result: ModelOption[] = []
  for (const item of raw.models) {
    if (!isObject(item)) continue
    if (item.visibility !== 'list') continue
    const slug = typeof item.slug === 'string' ? item.slug.trim() : ''
    if (!slug) continue
    const displayName =
      typeof item.display_name === 'string' && item.display_name.trim() !== ''
        ? item.display_name.trim()
        : slug
    const description =
      typeof item.description === 'string' && item.description.trim() !== ''
        ? item.description.trim()
        : 'OpenAI Codex model.'
    const rawLevels = Array.isArray(item.supported_reasoning_levels)
      ? item.supported_reasoning_levels
      : []
    const effortLevels: EffortLevel[] = EFFORT_LEVELS.filter((lvl) =>
      rawLevels.some((entry) => isObject(entry) && entry.effort === lvl)
    )
    result.push({
      value: `codex:${slug}`,
      resolvedModel: slug,
      name: `Codex (${displayName})`,
      description,
      effortLevels: effortLevels.length > 0 ? effortLevels : ['low', 'medium', 'high']
    })
  }
  return result
}

function mergeCodexModels(base: ModelLists, cached: ModelOption[]): ModelLists {
  if (cached.length === 0) return base
  const existingValues = new Set(base.models.map((m) => m.value))
  const additions = cached.filter((m) => !existingValues.has(m.value))
  return {
    ...base,
    models: [...base.models, ...additions]
  }
}

async function fetchModels(cwd: string): Promise<ModelsLoad> {
  const codexCached = await loadCodexCachedModels()
  const input = createInputQueue<SDKUserMessage>()
  const abortController = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const sdk = await loadSdk()
    const options: Options = {
      cwd,
      tools: [],
      permissionMode: 'default',
      strictMcpConfig: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      persistSession: false,
      abortController,
      env: childEnv(),
      ...claudeExecutable()
    }
    const query = sdk.query({ prompt: input.iterable, options })
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('The model list took too long to load.')),
          FETCH_TIMEOUT_MS
        )
      })
      const infos = await Promise.race([query.supportedModels(), timeout])
      return { ok: true, lists: mergeCodexModels(modelLists(infos), codexCached) }
    } finally {
      input.close()
      abortController.abort()
      query.close()
    }
  } catch (err) {
    console.error(
      '[models] Could not load the Claude model list, falling back to Codex/Gemini models:',
      err instanceof Error ? err.message : err
    )
    return { ok: true, lists: mergeCodexModels(modelLists([]), codexCached) }
  } finally {
    clearTimeout(timer)
  }
}

export function getModels(cwd: string): Promise<ModelsLoad> {
  let load = cache.get(cwd)
  if (!load) {
    load = fetchModels(cwd)
    cache.set(cwd, load)
    void load.then((result) => {
      if (!result.ok && cache.get(cwd) === load) cache.delete(cwd)
    })
  }
  return load
}

// Starts the fetch for the open project at startup, so the list is ready by the
// time the picker opens.
export function prefetchModels(cwd: string | null): void {
  if (cwd) void getModels(cwd)
}
