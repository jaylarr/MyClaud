import { BrowserWindow, dialog, ipcMain } from 'electron'
import {
  IpcChannel,
  type AgentSendResult,
  type ChatHistory,
  type CliProviderId,
  type ModelChoiceResult,
  type ModelsResult,
  type ProjectInfo
} from '../shared/ipc'
import { accountData, checkAccount, openUsagePage } from './account'
import { openInEditor } from './editor'
import {
  cancelProviderLogin,
  getProvidersStatus,
  installProviderCli,
  loginProviderOAuth,
  logoutProvider,
  saveProviderApiKey
} from './providerAuth'
import { chatChoice, listModels, saveChoice } from './modelChoice'
import { prefetchModels } from './models'
import { registerWindowIpc } from './windowControls'
import {
  addTheme,
  listThemes,
  removeTheme,
  renameTheme,
  setThemeChoice,
  themeChoices
} from './themes'
import {
  answerPermission,
  applyChoiceToRun,
  isRunning,
  loadChatHistory,
  resetChat,
  sendMessage,
  stopRun
} from './agent'
import { readPastedImages } from './pastedImages'
import {
  getOpenInEditor,
  getPartyPanel,
  getPopups,
  getProject,
  getTestCommand,
  setOpenInEditor,
  setPartyPanel,
  setTestCommand,
  setPopups,
  setProject
} from './settings'
import { setPopupsEnabled, showTestPopup } from './popupWindow'
import { agentStats, agentsSummary } from './progression'
import { bossIdsInFights, dismissFight, fightFor, fightOn } from './bosses'
import {
  createBoss,
  dropBossPicks,
  listBosses,
  pickBackground,
  pickIdle,
  removeBoss,
  setBossInPool,
  sliceIdle,
  updateBoss
} from './bossPacks'
import { achievementsData, equip, markAllSeen } from './progressionStore'
import { clearFinishedTasks, getTask, listTasks, markTaskSeen, removeTask } from './tasks'
import { createAgent, listAgents, readAgent, removeAgent, updateAgent } from './agents'
import { discardIcon, pickIcon } from './agentIcons'
import {
  createMascot,
  discardSheet,
  dropSources,
  getActiveMascot,
  listMascots,
  pickSheet,
  removeMascot,
  resetDefaultMascot,
  setActiveMascot,
  sliceSheet,
  updateMascot
} from './mascots'

export function registerIpc(): void {
  registerWindowIpc()

  ipcMain.handle(IpcChannel.ProjectGet, (): ProjectInfo | null => getProject())

  ipcMain.handle(IpcChannel.ProjectOpen, async (event): Promise<ProjectInfo | null> => {
    // The run belongs to the open project; it cannot change under it.
    if (isRunning()) return null

    const window = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Open project',
      properties: ['openDirectory']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0 || isRunning()) return null

    const opened = await setProject(result.filePaths[0])
    // The new folder's model list starts loading now.
    prefetchModels(opened.path)
    if (await getOpenInEditor()) openInEditor(opened.path)
    return opened
  })

  // `call` is { scope, filePath } of an agent from the list; agent.ts checks it again.
  // `messageId` is the window's UUID for this message; agent.ts checks its shape.
  // `images` are pasted images as { bytes }; they are checked here. A message needs text
  // that is not blank or at least one image.
  ipcMain.handle(
    IpcChannel.AgentSend,
    async (
      event,
      prompt: unknown,
      call: unknown,
      messageId: unknown,
      images: unknown
    ): Promise<AgentSendResult> => {
      const pasted = readPastedImages(images)
      if (!pasted.ok) {
        return { ok: false, error: { code: 'invalid_image', message: pasted.message } }
      }
      if (typeof prompt !== 'string' || (prompt.trim() === '' && pasted.images.length === 0)) {
        return {
          ok: false,
          error: { code: 'invalid_prompt', message: 'The prompt must be non-empty text.' }
        }
      }
      const project = getProject()
      if (!project) {
        return { ok: false, error: { code: 'no_project', message: 'No project is open.' } }
      }
      return sendMessage(prompt, call, messageId, project.path, event.sender, pasted.images)
    }
  )

  ipcMain.handle(IpcChannel.AgentStop, (): void => {
    stopRun()
  })

  ipcMain.handle(
    IpcChannel.AgentPermission,
    (_event, permissionId: unknown, decision: unknown): { ok: boolean } => {
      if (typeof permissionId !== 'string' || (decision !== 'approve' && decision !== 'deny')) {
        return { ok: false }
      }
      return { ok: answerPermission(permissionId, decision) }
    }
  )

  // Agent files. Every handler validates its arguments again in agents.ts.
  ipcMain.handle(IpcChannel.AgentsList, () => listAgents())
  ipcMain.handle(IpcChannel.AgentsRead, (_event, filePath: unknown) => readAgent(filePath))
  ipcMain.handle(IpcChannel.AgentsCreate, (_event, draft: unknown) => createAgent(draft))
  ipcMain.handle(
    IpcChannel.AgentsUpdate,
    (_event, filePath: unknown, draft: unknown, modifiedTime: unknown) =>
      updateAgent(filePath, draft, modifiedTime)
  )
  ipcMain.handle(IpcChannel.AgentsRemove, (_event, filePath: unknown) => removeAgent(filePath))
  // The renderer never sends an icon path: main opens the picker itself.
  ipcMain.handle(IpcChannel.AgentsPickIcon, (event) =>
    pickIcon(BrowserWindow.fromWebContents(event.sender))
  )
  ipcMain.handle(IpcChannel.AgentsDiscardIcon, (_event, token: unknown) => {
    if (typeof token === 'string') discardIcon(token)
  })

  // Mascots. The renderer names a mascot by id only; mascots.ts checks every argument again.
  ipcMain.handle(IpcChannel.MascotsList, () => listMascots())
  ipcMain.handle(IpcChannel.MascotsGetActive, () => getActiveMascot())
  ipcMain.handle(IpcChannel.MascotsPickSheet, (event) =>
    pickSheet(BrowserWindow.fromWebContents(event.sender))
  )
  ipcMain.handle(IpcChannel.MascotsDiscardSheet, (_event, token: unknown) => {
    if (typeof token === 'string') discardSheet(token)
  })
  // The renderer sends a source token and numbers only; mascots.ts checks the slice again.
  ipcMain.handle(
    IpcChannel.MascotsSliceSheet,
    (_event, sourceToken: unknown, columns: unknown, rows: unknown, cells: unknown) =>
      sliceSheet(sourceToken, columns, rows, cells)
  )
  ipcMain.handle(IpcChannel.MascotsDropSources, () => dropSources())
  ipcMain.handle(IpcChannel.MascotsCreate, (_event, draft: unknown) => createMascot(draft))
  ipcMain.handle(IpcChannel.MascotsUpdate, (_event, id: unknown, draft: unknown) =>
    updateMascot(id, draft)
  )
  ipcMain.handle(IpcChannel.MascotsRemove, (_event, id: unknown) => removeMascot(id))
  ipcMain.handle(IpcChannel.MascotsResetDefault, () => resetDefaultMascot())
  ipcMain.handle(IpcChannel.MascotsSetActive, (_event, id: unknown) => setActiveMascot(id))

  // The open project's main conversation.
  ipcMain.handle(IpcChannel.ChatHistory, async (): Promise<ChatHistory> => {
    const project = getProject()
    return project
      ? loadChatHistory(project.path)
      : { items: [], truncated: false, unavailable: false }
  })
  ipcMain.handle(IpcChannel.ChatReset, async () => {
    const project = getProject()
    if (!project) {
      return { ok: false, error: { code: 'no_project', message: 'No project is open.' } }
    }
    return resetChat(project.path)
  })

  // The chat's model and thinking choice, and the models the account can use. The
  // window names no folder: main uses the open project.
  const noProject = { ok: false, error: { message: 'No project is open.' } } as const
  ipcMain.handle(IpcChannel.ChatGetModelChoice, async (): Promise<ModelChoiceResult> => {
    const project = getProject()
    return project ? chatChoice(project.path) : noProject
  })
  ipcMain.handle(
    IpcChannel.ChatSetModelChoice,
    async (_event, change: unknown): Promise<ModelChoiceResult> => {
      const project = getProject()
      if (!project) return noProject
      const saved = await saveChoice(project.path, change)
      // During a run the pick applies from the next message.
      if (saved.ok) await applyChoiceToRun(saved.choice)
      return saved
    }
  )
  // Chat themes. The window names a theme by id only; themes.ts checks every id.
  ipcMain.handle(IpcChannel.ThemesList, () => listThemes())
  ipcMain.handle(IpcChannel.ThemesAdd, (event) =>
    addTheme(BrowserWindow.fromWebContents(event.sender))
  )
  ipcMain.handle(IpcChannel.ThemesRename, (_event, id: unknown, name: unknown) =>
    renameTheme(id, name)
  )
  ipcMain.handle(IpcChannel.ThemesRemove, (_event, id: unknown) =>
    removeTheme(id, getProject()?.path ?? null)
  )
  ipcMain.handle(IpcChannel.ThemesGetChoice, () => themeChoices(getProject()?.path ?? null))
  ipcMain.handle(IpcChannel.ThemesSetChoice, (_event, change: unknown) =>
    setThemeChoice(getProject()?.path ?? null, change)
  )

  ipcMain.handle(IpcChannel.ModelsList, async (): Promise<ModelsResult> => {
    const project = getProject()
    return project
      ? listModels(project.path)
      : { ok: false, message: "Couldn't load the model list." }
  })

  // Tasks. The renderer names a task by id only; tasks.ts checks it is one it knows.
  ipcMain.handle(IpcChannel.TasksList, () => listTasks(getProject()?.path ?? null))
  ipcMain.handle(IpcChannel.TasksGet, (_event, id: unknown) =>
    getTask(id, getProject()?.path ?? null)
  )
  ipcMain.handle(IpcChannel.TasksMarkSeen, (_event, id: unknown) => markTaskSeen(id))
  ipcMain.handle(IpcChannel.TasksRemove, (_event, id: unknown) => removeTask(id))
  ipcMain.handle(IpcChannel.TasksClearFinished, () =>
    clearFinishedTasks(getProject()?.path ?? null)
  )

  // The account and usage. None of these takes an argument from the window: the page
  // that opens is a fixed address in account.ts, and a read asks Claude Code only for
  // what it knows from starting up.
  ipcMain.handle(IpcChannel.AccountGet, () => accountData())
  ipcMain.handle(IpcChannel.AccountCheck, () => checkAccount())
  ipcMain.handle(IpcChannel.AccountOpenUsagePage, () => openUsagePage())

  // The party panel's open or rail choice, kept in settings.json.
  ipcMain.handle(IpcChannel.UiGetPartyPanel, () => getPartyPanel())
  ipcMain.handle(IpcChannel.UiSetPartyPanel, async (_event, mode: unknown) => {
    if (mode !== 'open' && mode !== 'rail') return { ok: false }
    try {
      await setPartyPanel(mode)
      return { ok: true }
    } catch (err) {
      console.error('Could not save settings:', err instanceof Error ? err.message : err)
      return { ok: false }
    }
  })

  // Popups on or off, kept in settings.json, and TEST POPUP.
  ipcMain.handle(IpcChannel.UiGetPopups, () => getPopups())
  ipcMain.handle(IpcChannel.UiSetPopups, async (_event, on: unknown) => {
    if (typeof on !== 'boolean') return { ok: false }
    // Takes effect at once, even if saving fails.
    setPopupsEnabled(on)
    try {
      await setPopups(on)
      return { ok: true }
    } catch (err) {
      console.error('Could not save settings:', err instanceof Error ? err.message : err)
      return { ok: false }
    }
  })
  ipcMain.handle(IpcChannel.UiTestPopup, () => showTestPopup())

  // Progression. The window names an agent by a listed file path only; progression.ts
  // checks it against the list, and equip checks the reward is unlocked.
  ipcMain.handle(IpcChannel.ProgressionAgentsSummary, () => agentsSummary())
  ipcMain.handle(IpcChannel.ProgressionAgentStats, (_event, filePath: unknown) =>
    agentStats(filePath)
  )
  ipcMain.handle(IpcChannel.ProgressionAchievements, () => achievementsData())
  ipcMain.handle(IpcChannel.ProgressionEquip, async (_event, change: unknown) => ({
    ok: await equip(change)
  }))
  ipcMain.handle(IpcChannel.ProgressionMarkSeen, () => markAllSeen())

  // Boss battles. The window never sends a path: main uses the open project and its
  // conversation. The test command is checked and trimmed in settings.ts.
  // The boss manager: ids, tokens, and numbers only. bossPacks.ts checks every field again and
  // builds every path itself.
  ipcMain.handle(IpcChannel.BossesList, async () => listBosses(await bossIdsInFights()))
  ipcMain.handle(IpcChannel.BossesPickIdle, (event) =>
    pickIdle(BrowserWindow.fromWebContents(event.sender))
  )
  ipcMain.handle(
    IpcChannel.BossesSliceIdle,
    (_event, sourceToken: unknown, columns: unknown, rows: unknown, cells: unknown) =>
      sliceIdle(sourceToken, columns, rows, cells)
  )
  ipcMain.handle(IpcChannel.BossesDropSources, () => dropBossPicks())
  ipcMain.handle(IpcChannel.BossesPickBackground, (event) =>
    pickBackground(BrowserWindow.fromWebContents(event.sender))
  )
  ipcMain.handle(IpcChannel.BossesCreate, (_event, draft: unknown) => createBoss(draft))
  ipcMain.handle(IpcChannel.BossesUpdate, (_event, id: unknown, draft: unknown) =>
    updateBoss(id, draft)
  )
  ipcMain.handle(IpcChannel.BossesRemove, (_event, id: unknown) => removeBoss(id))
  ipcMain.handle(IpcChannel.BossesSetInPool, (_event, id: unknown, on: unknown) =>
    setBossInPool(id, on)
  )
  ipcMain.handle(IpcChannel.BossesFight, () => fightFor(getProject()?.path ?? null))
  ipcMain.handle(IpcChannel.BossesFightOn, () => fightOn(getProject()?.path ?? null))
  ipcMain.handle(IpcChannel.BossesDismiss, () => dismissFight(getProject()?.path ?? null))
  ipcMain.handle(IpcChannel.BossesGetTestCommand, async () => {
    const project = getProject()
    return project ? getTestCommand(project.path) : ''
  })
  ipcMain.handle(IpcChannel.BossesSetTestCommand, async (_event, command: unknown) => {
    const project = getProject()
    if (!project) return { ok: false, command: '' }
    try {
      const saved = await setTestCommand(project.path, command)
      return saved === null ? { ok: false, command: '' } : { ok: true, command: saved }
    } catch (err) {
      console.error('Could not save settings:', err instanceof Error ? err.message : err)
      return { ok: false, command: '' }
    }
  })

  // OPEN IN EDITOR on or off, kept in settings.json. Takes effect on the next OPEN/CHANGE.
  ipcMain.handle(IpcChannel.UiGetOpenInEditor, () => getOpenInEditor())
  ipcMain.handle(IpcChannel.UiSetOpenInEditor, async (_event, on: unknown) => {
    if (typeof on !== 'boolean') return { ok: false }
    try {
      await setOpenInEditor(on)
      return { ok: true }
    } catch (err) {
      console.error('Could not save settings:', err instanceof Error ? err.message : err)
      return { ok: false }
    }
  })

  const isCliProvider = (v: unknown): v is CliProviderId => v === 'codex' || v === 'gemini'

  ipcMain.handle(IpcChannel.ProvidersStatus, (_event, force: unknown) =>
    getProvidersStatus(force === true)
  )
  ipcMain.handle(IpcChannel.ProvidersLoginOAuth, async (_event, provider: unknown) => {
    if (!isCliProvider(provider)) {
      return { ok: false, error: 'Unknown provider.', status: await getProvidersStatus() }
    }
    return loginProviderOAuth(provider)
  })
  ipcMain.handle(IpcChannel.ProvidersCancelLogin, (_event, provider: unknown) => {
    if (!isCliProvider(provider)) return { ok: false }
    return cancelProviderLogin(provider)
  })
  ipcMain.handle(
    IpcChannel.ProvidersSaveApiKey,
    async (_event, provider: unknown, apiKey: unknown) => {
      if (!isCliProvider(provider) || typeof apiKey !== 'string') {
        return {
          ok: false,
          error: 'Invalid provider or API key.',
          status: await getProvidersStatus()
        }
      }
      return saveProviderApiKey(provider, apiKey)
    }
  )
  ipcMain.handle(IpcChannel.ProvidersLogout, async (_event, provider: unknown) => {
    if (!isCliProvider(provider)) {
      return { ok: false, error: 'Unknown provider.', status: await getProvidersStatus() }
    }
    return logoutProvider(provider)
  })
  ipcMain.handle(IpcChannel.ProvidersInstallCli, async (_event, provider: unknown) => {
    if (!isCliProvider(provider)) {
      return { ok: false, error: 'Unknown provider.', status: await getProvidersStatus() }
    }
    return installProviderCli(provider)
  })
}
