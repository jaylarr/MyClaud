import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { createInterface } from 'readline'
import type {
  AgentError,
  AgentEvent,
  AgentSummary,
  TaskAgent,
  TaskEndStatus,
  TaskLoot,
  TaskXp,
  ToolInput
} from '../shared/ipc'
import { winningAgent } from '../shared/agentGate'
import { parseCall } from '../shared/callAgent'
import { isEffortLevel, providerOf, stripProvider, type ModelChoice } from '../shared/models'
import { toolLabel } from '../shared/toolLabel'
import { readAgent } from './agents'
import { getProviderSession, setProviderSession, type CliProvider } from './chats'
import { forIpc } from './ipcInput'
import { providerChildEnv, shouldUseAgyForGemini } from './providerAuth'
import type { MessageTracker } from './runInput'
import { endTask, startTask, taskActivity } from './tasks'

export type CliRunContext = {
  requestId: string
  cwd: string
  choice: ModelChoice
  abortController: AbortController
  agents: AgentSummary[]
  input: {
    close: () => void
    readonly closed: boolean
    readonly iterable: AsyncIterable<{ message: { content: unknown }; uuid?: string }>
  }
  messages: MessageTracker
  emit: (event: AgentEvent) => void
  onReplyText: (text: string) => void
  onTaskEnded: (task: {
    taskId: string
    status: TaskEndStatus
    report: string
    agent: TaskAgent
    loot: TaskLoot | null
    xp: TaskXp | null
  }) => void
}

function lookOf(agents: AgentSummary[], name: string): TaskAgent {
  const file = winningAgent(agents, name)
  return file
    ? { name, scope: file.scope, filePath: file.filePath, icon: file.icon, role: file.role }
    : { name, scope: null, filePath: null, icon: null, role: null }
}

function normalizeToolName(rawName: string): string {
  const lower = rawName.toLowerCase()
  if (lower === 'read_file' || lower === 'read' || lower === 'view_file') return 'Read'
  if (
    lower === 'write_file' ||
    lower === 'write' ||
    lower === 'create_file' ||
    lower === 'write_to_file'
  )
    return 'Write'
  if (
    lower === 'edit_file' ||
    lower === 'replace' ||
    lower === 'edit' ||
    lower === 'patch' ||
    lower === 'replace_file_content' ||
    lower === 'multi_replace_file_content' ||
    lower === 'sed_file'
  )
    return 'Edit'
  if (
    lower === 'run_shell_command' ||
    lower === 'run_command' ||
    lower === 'bash' ||
    lower === 'shell' ||
    lower === 'command_execution'
  )
    return 'Bash'
  if (
    lower === 'grep' ||
    lower === 'grep_search' ||
    lower === 'search_file_content' ||
    lower === 'ripgrep'
  )
    return 'Grep'
  if (lower === 'glob' || lower === 'find_by_name' || lower === 'list_dir') return 'Glob'
  return rawName
}

function normalizeToolInput(toolName: string, raw: Record<string, unknown>): ToolInput {
  if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') {
    const filePath =
      raw.file_path ??
      raw.path ??
      raw.Path ??
      raw.TargetFile ??
      raw.target_file ??
      raw.filename ??
      raw.file ??
      ''
    return { ...raw, file_path: typeof filePath === 'string' ? filePath : '' }
  }
  if (toolName === 'Bash') {
    const command = raw.command ?? raw.CommandLine ?? raw.cmd ?? raw.script ?? ''
    return { ...raw, command: typeof command === 'string' ? command : '' }
  }
  if (toolName === 'Grep' || toolName === 'Glob') {
    const pattern =
      raw.pattern ??
      raw.Pattern ??
      raw.query ??
      raw.Query ??
      raw.DirectoryPath ??
      raw.glob ??
      ''
    return { ...raw, pattern: typeof pattern === 'string' ? pattern : '' }
  }
  return raw
}

async function buildPromptWithAgent(
  rawPrompt: string,
  agents: AgentSummary[]
): Promise<{
  finalPrompt: string
  calledAgent: TaskAgent | null
  agentModel: string | null
  description: string
}> {
  const parsed = parseCall(rawPrompt)
  if (!parsed) {
    return { finalPrompt: rawPrompt, calledAgent: null, agentModel: null, description: '' }
  }
  const agent = lookOf(agents, parsed.agentName)
  let systemInstructions = ''
  let agentModel: string | null = null
  if (agent.filePath) {
    const detail = await readAgent(agent.filePath).catch(() => null)
    if (detail && detail.ok) {
      if (detail.agent.body.trim() !== '') systemInstructions = detail.agent.body.trim()
      agentModel = detail.agent.model
    }
  }
  const finalPrompt = systemInstructions
    ? `You are acting as the "${agent.name}" agent.\n\nAgent instructions:\n${systemInstructions}\n\nUser request:\n${parsed.text}`
    : parsed.text
  const description = parsed.text.split(/\r?\n/)[0].slice(0, 80) || 'Agent task'
  return { finalPrompt, calledAgent: agent, agentModel, description }
}

export async function executeCliProvider(
  ctx: CliRunContext
): Promise<{ outcome: 'done' | AgentError }> {
  const baseProvider = providerOf(ctx.choice.model) as CliProvider
  const baseModelId = stripProvider(ctx.choice.model)
  const effort = isEffortLevel(ctx.choice.effort) ? ctx.choice.effort : 'auto'

  let codexThreadId = await getProviderSession(ctx.cwd, 'codex')
  let geminiSessionId = await getProviderSession(ctx.cwd, 'gemini')

  for await (const userMsg of ctx.input.iterable) {
    if (ctx.abortController.signal.aborted) break

    if (userMsg.uuid) {
      if (ctx.messages.started(userMsg.uuid)) {
        ctx.emit({
          requestId: ctx.requestId,
          type: 'message_state',
          messageId: userMsg.uuid,
          state: 'received'
        })
      }
    }

    const rawText = typeof userMsg.message?.content === 'string' ? userMsg.message.content : ''
    const { finalPrompt, calledAgent, agentModel, description } = await buildPromptWithAgent(
      rawText,
      ctx.agents
    )

    // Party agents whose file picks codex:* or gemini:* override the turn's provider/model.
    const agentProvider = agentModel ? providerOf(agentModel) : 'claude'
    const turnProvider: CliProvider =
      agentProvider !== 'claude' ? (agentProvider as CliProvider) : baseProvider
    const turnModelId =
      agentProvider !== 'claude' && agentModel ? stripProvider(agentModel) : baseModelId

    let taskId: string | null = null
    if (calledAgent) {
      taskId = randomUUID()
      ctx.emit({
        requestId: ctx.requestId,
        type: 'task_start',
        taskId,
        agent: calledAgent,
        description
      })
      await startTask({
        id: taskId,
        projectPath: ctx.cwd,
        sessionId: null,
        agent: { name: calledAgent.name, scope: calledAgent.scope, filePath: calledAgent.filePath },
        description,
        prompt: finalPrompt
      })
    } else {
      ctx.emit({
        requestId: ctx.requestId,
        type: 'reply_start',
        model: turnModelId,
        level: effort
      })
    }

    const turnResult =
      turnProvider === 'codex'
        ? await runCodexTurn({
            ctx,
            modelId: turnModelId,
            effort,
            prompt: finalPrompt,
            taskId,
            // Only resume the project's conversation when talking in the main chat.
            threadId: calledAgent ? null : codexThreadId,
            onThreadId: (id) => {
              if (!calledAgent) {
                codexThreadId = id
                void setProviderSession(ctx.cwd, 'codex', id)
              }
            }
          })
        : await runGeminiTurn({
            ctx,
            modelId: turnModelId,
            effort,
            prompt: finalPrompt,
            taskId,
            sessionId: calledAgent ? null : geminiSessionId,
            onSessionId: (id) => {
              if (!calledAgent) {
                geminiSessionId = id
                void setProviderSession(ctx.cwd, 'gemini', id)
              }
            }
          })

    if (!turnResult.ok && !calledAgent) {
      const msg = turnResult.error.message
      if (
        /session.*not found|thread.*not found|conversation.*not found|not found.*conversation|no conversation|unknown thread|invalid session/i.test(
          msg
        )
      ) {
        if (turnProvider === 'codex') codexThreadId = null
        else geminiSessionId = null
        await setProviderSession(ctx.cwd, turnProvider, null)
      }
    }

    if (taskId && calledAgent) {
      const status: TaskEndStatus = ctx.abortController.signal.aborted
        ? 'stopped'
        : turnResult.ok
          ? 'done'
          : 'error'
      const report = turnResult.ok ? turnResult.replyText : turnResult.error.message
      const truncated = report.length > 20_000
      const agentFile = calledAgent.filePath ? { filePath: calledAgent.filePath, tools: null } : null
      const { loot, xp } = await endTask(
        taskId,
        status,
        status === 'stopped' ? null : report,
        agentFile
      )
      ctx.emit({
        requestId: ctx.requestId,
        type: 'task_end',
        taskId,
        status,
        report: truncated ? report.slice(0, 20_000) : report,
        truncated,
        loot,
        xp
      })
      ctx.onTaskEnded({ taskId, status, report, agent: calledAgent, loot, xp })

      if (turnResult.ok && turnResult.replyText.trim() !== '') {
        ctx.emit({
          requestId: ctx.requestId,
          type: 'reply_start',
          model: turnModelId,
          level: effort
        })
        ctx.emit({ requestId: ctx.requestId, type: 'text', text: turnResult.replyText })
        ctx.onReplyText(turnResult.replyText)
      }
    }

    if (!turnResult.ok) {
      return { outcome: turnResult.error }
    }

    if (userMsg.uuid) {
      for (const late of ctx.messages.answered([userMsg.uuid])) {
        ctx.emit({
          requestId: ctx.requestId,
          type: 'message_state',
          messageId: late,
          state: 'received'
        })
      }
    }

    // Close the queue once all currently queued messages have been processed.
    if (ctx.messages.waiting === 0) {
      ctx.input.close()
      break
    }
  }

  return { outcome: 'done' }
}

type TurnOutcome = { ok: true; replyText: string } | { ok: false; error: AgentError }

async function runCodexTurn(opts: {
  ctx: CliRunContext
  modelId: string
  effort: string
  prompt: string
  taskId: string | null
  threadId: string | null
  onThreadId: (id: string) => void
}): Promise<TurnOutcome> {
  const { ctx, modelId, effort, prompt, taskId, threadId, onThreadId } = opts
  const args: string[] = ['exec']
  if (threadId) args.push('resume', threadId)
  args.push('--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check')
  if (modelId && modelId !== 'auto' && modelId !== 'default' && modelId !== 'gpt-5.3-codex') {
    args.push('-m', modelId)
  }
  if (effort !== 'auto') args.push('-c', `model_reasoning_effort=${effort}`)
  args.push('-')

  const env = await providerChildEnv('codex')
  return spawnJsonlProcess({
    binary: 'codex',
    args,
    env,
    stdinText: prompt,
    cwd: ctx.cwd,
    signal: ctx.abortController.signal,
    notFoundMessage:
      'CODEX_LOGIN: OpenAI Codex CLI is not installed. Open the LOGINS screen in the sidebar to install and sign in to Codex.',
    notSignedInPrefix:
      'CODEX_LOGIN: Not signed in to Codex. Open the LOGINS screen in the sidebar to sign in.',
    onEvent: (event, state) => {
      const type = typeof event.type === 'string' ? event.type : ''
      if (type === 'thread.started' && typeof event.thread_id === 'string') {
        onThreadId(event.thread_id)
        return
      }
      if (type === 'item.started' && typeof event.item === 'object' && event.item !== null) {
        const item = event.item as Record<string, unknown>
        const itemId = typeof item.id === 'string' ? item.id : randomUUID()
        const itemType = typeof item.type === 'string' ? item.type : ''
        if (itemType === 'reasoning') {
          state.thinkingStart = Date.now()
          return
        }
        if (
          itemType === 'command_execution' ||
          itemType === 'file_change' ||
          itemType === 'mcp_tool_call'
        ) {
          const toolName =
            itemType === 'command_execution'
              ? 'Bash'
              : itemType === 'file_change'
                ? 'Edit'
                : normalizeToolName(typeof item.tool_name === 'string' ? item.tool_name : 'Tool')
          const rawInput: Record<string, unknown> =
            itemType === 'command_execution'
              ? { command: typeof item.command === 'string' ? item.command : '' }
              : itemType === 'file_change'
                ? {
                    file_path:
                      Array.isArray(item.changes) && item.changes[0]
                        ? String((item.changes[0] as Record<string, unknown>).path ?? '')
                        : ''
                  }
                : typeof item.arguments === 'object' && item.arguments !== null
                  ? (item.arguments as Record<string, unknown>)
                  : {}
          const shown = forIpc(normalizeToolInput(toolName, rawInput))
          ctx.emit({
            requestId: ctx.requestId,
            type: 'tool_start',
            toolId: itemId,
            name: toolName,
            taskId
          })
          ctx.emit({
            requestId: ctx.requestId,
            type: 'tool_input',
            toolId: itemId,
            input: shown.input,
            truncated: shown.truncated,
            taskId
          })
          if (taskId) {
            taskActivity(taskId, itemId, toolLabel(toolName, shown.input, ctx.cwd), 'running')
          }
        }
        return
      }
      if (type === 'item.completed' && typeof event.item === 'object' && event.item !== null) {
        const item = event.item as Record<string, unknown>
        const itemId = typeof item.id === 'string' ? item.id : ''
        const itemType = typeof item.type === 'string' ? item.type : ''
        if (itemType === 'reasoning' && state.thinkingStart !== null) {
          if (!taskId) {
            ctx.emit({
              requestId: ctx.requestId,
              type: 'thought',
              ms: Date.now() - state.thinkingStart
            })
          }
          state.thinkingStart = null
          return
        }
        if (itemType === 'agent_message' && typeof item.text === 'string' && item.text !== '') {
          const chunk = state.replyText === '' ? item.text : `\n\n${item.text}`
          state.replyText += chunk
          if (!taskId) {
            ctx.emit({ requestId: ctx.requestId, type: 'text', text: chunk })
            ctx.onReplyText(state.replyText)
          }
          return
        }
        if (
          itemType === 'command_execution' ||
          itemType === 'file_change' ||
          itemType === 'mcp_tool_call'
        ) {
          const failed = typeof item.exit_code === 'number' && item.exit_code !== 0
          const endState = failed ? 'failed' : 'done'
          ctx.emit({
            requestId: ctx.requestId,
            type: 'tool_end',
            toolId: itemId,
            state: endState,
            taskId
          })
          if (taskId) taskActivity(taskId, itemId, null, endState)
        }
        return
      }
      if (type === 'turn.failed' || type === 'error') {
        const errObj = (
          typeof event.error === 'object' && event.error !== null ? event.error : event
        ) as Record<string, unknown>
        const msg = typeof errObj.message === 'string' ? errObj.message : 'Codex run failed.'
        state.errorMessage = msg
      }
    }
  })
}

async function runGeminiTurn(opts: {
  ctx: CliRunContext
  modelId: string
  effort: string
  prompt: string
  taskId: string | null
  sessionId: string | null
  onSessionId: (id: string) => void
}): Promise<TurnOutcome> {
  const { ctx, modelId, effort, prompt, taskId, sessionId, onSessionId } = opts
  const { useAgy, agyBinary } = await shouldUseAgyForGemini()
  const env = await providerChildEnv('gemini')

  if (useAgy) {
    const args: string[] = ['--output-format', 'stream-json', '--dangerously-skip-permissions']
    if (modelId && modelId !== 'auto' && modelId !== 'default' && modelId !== 'gemini-2.5-pro') {
      const mapped = modelId === 'gemini-2.5-flash' ? 'gemini-3.8-flash-high' : modelId
      args.push('--model', mapped)
    }
    if (effort !== 'auto') args.push('--effort', effort)
    if (sessionId) args.push('--conversation', sessionId)
    args.push('-p', prompt)

    return spawnJsonlProcess({
      binary: agyBinary,
      args,
      env,
      stdinText: '',
      useShell: false,
      cwd: ctx.cwd,
      signal: ctx.abortController.signal,
      notFoundMessage:
        'GEMINI_LOGIN: Google Antigravity CLI (agy) is not installed. Open the LOGINS screen in the sidebar to install and sign in.',
      notSignedInPrefix:
        'GEMINI_LOGIN: Not signed in to Google Gemini. Open the LOGINS screen in the sidebar to sign in.',
      onEvent: (event, state) => {
        const evName = typeof event.event === 'string' ? event.event : ''
        if (evName === 'init' && typeof event.conversation_id === 'string') {
          onSessionId(event.conversation_id)
          return
        }
        if (
          evName === 'step_update' &&
          typeof event.step_update === 'object' &&
          event.step_update !== null
        ) {
          const step = event.step_update as Record<string, unknown>
          const stepType = typeof step.step_type === 'string' ? step.step_type : ''
          const stepState = typeof step.state === 'string' ? step.state : ''
          const stepIdx = typeof step.step_index === 'number' ? String(step.step_index) : '0'
          if (stepType === 'agent_response') {
            const delta = typeof step.text_delta === 'string' ? step.text_delta : ''
            if (delta !== '') {
              state.sawDelta = true
              state.replyText += delta
              if (!taskId) {
                ctx.emit({ requestId: ctx.requestId, type: 'text', text: delta })
                ctx.onReplyText(state.replyText)
              }
            }
            return
          }
          if (stepType === 'tool') {
            const toolId = `agy-tool-${stepIdx}`
            const rawName = typeof step.tool_name === 'string' ? step.tool_name : 'Tool'
            const toolName = normalizeToolName(rawName)
            const toolInfo =
              typeof step.tool_info === 'object' && step.tool_info !== null
                ? (step.tool_info as Record<string, unknown>)
                : {}
            const rawParams =
              typeof toolInfo.parameters === 'object' && toolInfo.parameters !== null
                ? (toolInfo.parameters as Record<string, unknown>)
                : {}
            if (stepState === 'ACTIVE') {
              const shown = forIpc(normalizeToolInput(toolName, rawParams))
              ctx.emit({
                requestId: ctx.requestId,
                type: 'tool_start',
                toolId,
                name: toolName,
                taskId
              })
              ctx.emit({
                requestId: ctx.requestId,
                type: 'tool_input',
                toolId,
                input: shown.input,
                truncated: shown.truncated,
                taskId
              })
              if (taskId) {
                taskActivity(taskId, toolId, toolLabel(toolName, shown.input, ctx.cwd), 'running')
              }
            } else if (stepState === 'DONE' || stepState === 'ERROR' || stepState === 'FAILED') {
              const endState = stepState === 'DONE' ? 'done' : 'failed'
              ctx.emit({
                requestId: ctx.requestId,
                type: 'tool_end',
                toolId,
                state: endState,
                taskId
              })
              if (taskId) taskActivity(taskId, toolId, null, endState)
            }
            return
          }
          return
        }
        if (evName === 'result' && typeof event.result === 'object' && event.result !== null) {
          const res = event.result as Record<string, unknown>
          if (res.status === 'ERROR' || res.status === 'FAILED') {
            state.errorMessage =
              typeof res.error === 'string' ? res.error : 'Gemini (agy) reported an error.'
          } else if (!state.sawDelta && typeof res.response === 'string' && res.response !== '') {
            state.replyText += res.response
            if (!taskId) {
              ctx.emit({ requestId: ctx.requestId, type: 'text', text: res.response })
              ctx.onReplyText(state.replyText)
            }
          }
        }
      }
    })
  }

  const args: string[] = ['--output-format', 'stream-json', '--yolo', '--skip-trust']
  if (modelId && modelId !== 'auto') args.push('-m', modelId)
  if (sessionId) args.push('--resume', sessionId)

  return spawnJsonlProcess({
    binary: 'gemini',
    args,
    env,
    stdinText: prompt,
    cwd: ctx.cwd,
    signal: ctx.abortController.signal,
    notFoundMessage:
      'GEMINI_LOGIN: Google Gemini CLI is not installed. Open the LOGINS screen in the sidebar to install and sign in to Gemini.',
    notSignedInPrefix:
      'GEMINI_LOGIN: Not signed in to Gemini. Open the LOGINS screen in the sidebar to sign in.',
    onEvent: (event, state) => {
      const type = typeof event.type === 'string' ? event.type : ''
      if (type === 'init') {
        const sid =
          typeof event.session_id === 'string'
            ? event.session_id
            : typeof event.sessionId === 'string'
              ? event.sessionId
              : ''
        if (sid) onSessionId(sid)
        return
      }
      if (type === 'message') {
        const role = typeof event.role === 'string' ? event.role : 'assistant'
        const content = typeof event.content === 'string' ? event.content : ''
        if (role === 'assistant' && content !== '') {
          if (event.delta === true) {
            state.sawDelta = true
            state.turnBuffer += content
            state.replyText += content
            if (!taskId) {
              ctx.emit({ requestId: ctx.requestId, type: 'text', text: content })
              ctx.onReplyText(state.replyText)
            }
          } else if (state.sawDelta) {
            // Gemini emits a final full-message event after delta chunks; emit only unseen tail.
            const suffix = content.startsWith(state.turnBuffer)
              ? content.slice(state.turnBuffer.length)
              : ''
            state.sawDelta = false
            state.turnBuffer = ''
            if (suffix !== '') {
              state.replyText += suffix
              if (!taskId) {
                ctx.emit({ requestId: ctx.requestId, type: 'text', text: suffix })
                ctx.onReplyText(state.replyText)
              }
            }
          } else {
            const chunk = state.replyText === '' ? content : `\n\n${content}`
            state.replyText += chunk
            if (!taskId) {
              ctx.emit({ requestId: ctx.requestId, type: 'text', text: chunk })
              ctx.onReplyText(state.replyText)
            }
          }
        }
        return
      }
      if (type === 'tool_use') {
        state.sawDelta = false
        state.turnBuffer = ''
        const toolId =
          typeof event.id === 'string'
            ? event.id
            : typeof event.tool_id === 'string'
              ? event.tool_id
              : randomUUID()
        const rawName =
          typeof event.name === 'string'
            ? event.name
            : typeof event.tool_name === 'string'
              ? event.tool_name
              : 'Tool'
        const toolName = normalizeToolName(rawName)
        const rawInput =
          typeof event.input === 'object' && event.input !== null
            ? (event.input as Record<string, unknown>)
            : typeof event.parameters === 'object' && event.parameters !== null
              ? (event.parameters as Record<string, unknown>)
              : {}
        const shown = forIpc(normalizeToolInput(toolName, rawInput))
        ctx.emit({ requestId: ctx.requestId, type: 'tool_start', toolId, name: toolName, taskId })
        ctx.emit({
          requestId: ctx.requestId,
          type: 'tool_input',
          toolId,
          input: shown.input,
          truncated: shown.truncated,
          taskId
        })
        if (taskId) {
          taskActivity(taskId, toolId, toolLabel(toolName, shown.input, ctx.cwd), 'running')
        }
        return
      }
      if (type === 'tool_result') {
        state.sawDelta = false
        state.turnBuffer = ''
        const toolId =
          typeof event.tool_use_id === 'string'
            ? event.tool_use_id
            : typeof event.tool_id === 'string'
              ? event.tool_id
              : ''
        const failed = event.is_error === true || event.status === 'error'
        const endState = failed ? 'failed' : 'done'
        if (toolId) {
          ctx.emit({ requestId: ctx.requestId, type: 'tool_end', toolId, state: endState, taskId })
          if (taskId) taskActivity(taskId, toolId, null, endState)
        }
        return
      }
      if (type === 'error' || (type === 'result' && event.status === 'error')) {
        const msg =
          typeof event.message === 'string'
            ? event.message
            : typeof (event.error as { message?: unknown } | undefined)?.message === 'string'
              ? (event.error as { message: string }).message
              : 'Gemini CLI reported an error.'
        state.errorMessage = msg
      }
    }
  })
}

type StreamState = {
  replyText: string
  turnBuffer: string
  sawDelta: boolean
  thinkingStart: number | null
  errorMessage: string | null
}

function spawnJsonlProcess(opts: {
  binary: string
  args: string[]
  env: NodeJS.ProcessEnv
  stdinText: string
  useShell?: boolean
  cwd: string
  signal: AbortSignal
  notFoundMessage: string
  notSignedInPrefix: string
  onEvent: (event: Record<string, unknown>, state: StreamState) => void
}): Promise<TurnOutcome> {
  return new Promise<TurnOutcome>((resolve) => {
    const state: StreamState = {
      replyText: '',
      turnBuffer: '',
      sawDelta: false,
      thinkingStart: null,
      errorMessage: null
    }
    let stderrText = ''
    let settled = false

    const finish = (result: TurnOutcome): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const child = spawn(opts.binary, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: opts.useShell ?? process.platform === 'win32',
      windowsHide: true
    })

    if (child.stdin) {
      child.stdin.on('error', () => {
        // Ignore EPIPE if the child exits before stdin finishes writing.
      })
      child.stdin.end(opts.stdinText, 'utf8')
    }

    const onAbort = (): void => {
      if (process.platform === 'win32' && child.pid) {
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
          return
        } catch {
          // Fall back to child.kill() below.
        }
      }
      child.kill()
    }
    opts.signal.addEventListener('abort', onAbort, { once: true })

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
      rl.on('line', (line) => {
        const trimmed = line.trim()
        if (!trimmed.startsWith('{')) return
        try {
          const parsed: unknown = JSON.parse(trimmed)
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            opts.onEvent(parsed as Record<string, unknown>, state)
          }
        } catch {
          // Ignore non-JSON lines on stdout.
        }
      })
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        stderrText += chunk.toString('utf8')
      })
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      opts.signal.removeEventListener('abort', onAbort)
      if (err.code === 'ENOENT') {
        finish({ ok: false, error: { code: 'not_signed_in', message: opts.notFoundMessage } })
      } else {
        finish({ ok: false, error: { code: 'sdk_error', message: err.message } })
      }
    })

    child.on('close', (code) => {
      opts.signal.removeEventListener('abort', onAbort)
      if (opts.signal.aborted) {
        finish({ ok: true, replyText: state.replyText })
        return
      }
      const trimmedErr = stderrText.trim()
      if (
        code !== 0 &&
        /is not recognized as an internal or external command|command not found|ENOENT/i.test(
          trimmedErr
        )
      ) {
        finish({ ok: false, error: { code: 'not_signed_in', message: opts.notFoundMessage } })
        return
      }
      if (state.errorMessage || (code !== 0 && state.replyText.trim() === '')) {
        const rawErr = (state.errorMessage ?? cleanCliStderr(trimmedErr)) || `Exited with code ${code}`
        const isAuth =
          /\b(please run .*login|unauthorized|status 401|not logged in|not signed in|missing api key)\b/i.test(
            rawErr
          )
        const isRate = /rate.?limit|429|quota/i.test(rawErr)
        finish({
          ok: false,
          error: {
            code: isAuth ? 'not_signed_in' : isRate ? 'rate_limit' : 'sdk_error',
            message: isAuth ? opts.notSignedInPrefix : rawErr
          }
        })
        return
      }
      finish({ ok: true, replyText: state.replyText })
    })
  })
}

function cleanCliStderr(stderr: string): string {
  if (!stderr) return ''
  if (/IneligibleTierError/i.test(stderr)) {
    return 'Google has retired consumer Google OAuth sign-in on standalone @google/gemini-cli ("This client is no longer supported for Gemini Code Assist for individuals — migrate to Antigravity"). To use Gemini in MyClaud, paste a Gemini API key from Google AI Studio (aistudio.google.com/apikey) in the LOGINS tab.'
  }
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(
      (l) =>
        l !== '' &&
        !l.startsWith('Warning: 256-color') &&
        !l.startsWith('YOLO mode is enabled') &&
        !l.startsWith('Ripgrep is not available') &&
        !l.startsWith('Skill conflict detected:') &&
        !l.startsWith('at ')
    )
  return lines.join('\n') || stderr
}
