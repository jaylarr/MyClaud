import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AccountData } from '../shared/account'
import type { UnlockNotice } from '../shared/achievements'
import type { FightEvent } from '../shared/bosses'
import {
  IpcChannel,
  type AgentEvent,
  type MyaApi,
  type PopupOpenTarget,
  type WindowState
} from '../shared/ipc'

// The only API the renderer gets. ipcRenderer itself is never exposed.
const api: MyaApi = {
  project: {
    get: () => ipcRenderer.invoke(IpcChannel.ProjectGet),
    open: () => ipcRenderer.invoke(IpcChannel.ProjectOpen)
  },
  agent: {
    send: (prompt, call, messageId, images) =>
      ipcRenderer.invoke(IpcChannel.AgentSend, prompt, call ?? null, messageId, images ?? []),
    stop: () => ipcRenderer.invoke(IpcChannel.AgentStop),
    answerPermission: (permissionId, decision) =>
      ipcRenderer.invoke(IpcChannel.AgentPermission, permissionId, decision),
    onEvent: (callback) => {
      const listener = (_event: IpcRendererEvent, agentEvent: AgentEvent): void =>
        callback(agentEvent)
      ipcRenderer.on(IpcChannel.AgentEvent, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.AgentEvent, listener)
      }
    }
  },
  agents: {
    list: () => ipcRenderer.invoke(IpcChannel.AgentsList),
    read: (filePath) => ipcRenderer.invoke(IpcChannel.AgentsRead, filePath),
    create: (draft) => ipcRenderer.invoke(IpcChannel.AgentsCreate, draft),
    update: (filePath, draft, modifiedTime) =>
      ipcRenderer.invoke(IpcChannel.AgentsUpdate, filePath, draft, modifiedTime),
    remove: (filePath) => ipcRenderer.invoke(IpcChannel.AgentsRemove, filePath),
    pickIcon: () => ipcRenderer.invoke(IpcChannel.AgentsPickIcon),
    discardIcon: (token) => ipcRenderer.invoke(IpcChannel.AgentsDiscardIcon, token)
  },
  mascots: {
    list: () => ipcRenderer.invoke(IpcChannel.MascotsList),
    getActive: () => ipcRenderer.invoke(IpcChannel.MascotsGetActive),
    pickSheet: () => ipcRenderer.invoke(IpcChannel.MascotsPickSheet),
    discardSheet: (token) => ipcRenderer.invoke(IpcChannel.MascotsDiscardSheet, token),
    sliceSheet: (sourceToken, columns, rows, cells) =>
      ipcRenderer.invoke(IpcChannel.MascotsSliceSheet, sourceToken, columns, rows, cells),
    dropSources: () => ipcRenderer.invoke(IpcChannel.MascotsDropSources),
    create: (draft) => ipcRenderer.invoke(IpcChannel.MascotsCreate, draft),
    update: (id, draft) => ipcRenderer.invoke(IpcChannel.MascotsUpdate, id, draft),
    remove: (id) => ipcRenderer.invoke(IpcChannel.MascotsRemove, id),
    resetDefault: () => ipcRenderer.invoke(IpcChannel.MascotsResetDefault),
    setActive: (id) => ipcRenderer.invoke(IpcChannel.MascotsSetActive, id),
    onChanged: (callback) => {
      const listener = (): void => callback()
      ipcRenderer.on(IpcChannel.MascotsChanged, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.MascotsChanged, listener)
      }
    }
  },
  chat: {
    history: () => ipcRenderer.invoke(IpcChannel.ChatHistory),
    reset: () => ipcRenderer.invoke(IpcChannel.ChatReset),
    getModelChoice: () => ipcRenderer.invoke(IpcChannel.ChatGetModelChoice),
    setModelChoice: (change) => ipcRenderer.invoke(IpcChannel.ChatSetModelChoice, change)
  },
  models: {
    list: () => ipcRenderer.invoke(IpcChannel.ModelsList)
  },
  themes: {
    list: () => ipcRenderer.invoke(IpcChannel.ThemesList),
    add: () => ipcRenderer.invoke(IpcChannel.ThemesAdd),
    rename: (id, name) => ipcRenderer.invoke(IpcChannel.ThemesRename, id, name),
    remove: (id) => ipcRenderer.invoke(IpcChannel.ThemesRemove, id),
    getChoice: () => ipcRenderer.invoke(IpcChannel.ThemesGetChoice),
    setChoice: (change) => ipcRenderer.invoke(IpcChannel.ThemesSetChoice, change)
  },
  tasks: {
    list: () => ipcRenderer.invoke(IpcChannel.TasksList),
    get: (taskId) => ipcRenderer.invoke(IpcChannel.TasksGet, taskId),
    markSeen: (taskId) => ipcRenderer.invoke(IpcChannel.TasksMarkSeen, taskId),
    remove: (taskId) => ipcRenderer.invoke(IpcChannel.TasksRemove, taskId),
    clearFinished: () => ipcRenderer.invoke(IpcChannel.TasksClearFinished),
    onChanged: (callback) => {
      const listener = (): void => callback()
      ipcRenderer.on(IpcChannel.TasksChanged, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.TasksChanged, listener)
      }
    }
  },
  account: {
    get: () => ipcRenderer.invoke(IpcChannel.AccountGet),
    check: () => ipcRenderer.invoke(IpcChannel.AccountCheck),
    onChange: (callback) => {
      const listener = (_event: IpcRendererEvent, data: AccountData): void => callback(data)
      ipcRenderer.on(IpcChannel.AccountChanged, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.AccountChanged, listener)
      }
    },
    openUsagePage: () => ipcRenderer.invoke(IpcChannel.AccountOpenUsagePage)
  },
  window: {
    minimize: () => ipcRenderer.invoke(IpcChannel.WindowMinimize),
    toggleMaximize: (source) => ipcRenderer.invoke(IpcChannel.WindowToggleMaximize, source),
    close: () => ipcRenderer.invoke(IpcChannel.WindowClose),
    getState: () => ipcRenderer.invoke(IpcChannel.WindowGetState),
    onState: (callback) => {
      const listener = (_event: IpcRendererEvent, state: WindowState): void => callback(state)
      ipcRenderer.on(IpcChannel.WindowState, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.WindowState, listener)
      }
    }
  },
  ui: {
    getPartyPanel: () => ipcRenderer.invoke(IpcChannel.UiGetPartyPanel),
    setPartyPanel: (mode) => ipcRenderer.invoke(IpcChannel.UiSetPartyPanel, mode),
    getPopups: () => ipcRenderer.invoke(IpcChannel.UiGetPopups),
    setPopups: (on) => ipcRenderer.invoke(IpcChannel.UiSetPopups, on),
    testPopup: () => ipcRenderer.invoke(IpcChannel.UiTestPopup),
    getOpenInEditor: () => ipcRenderer.invoke(IpcChannel.UiGetOpenInEditor),
    setOpenInEditor: (on) => ipcRenderer.invoke(IpcChannel.UiSetOpenInEditor, on),
    onOpen: (callback) => {
      const listener = (_event: IpcRendererEvent, target: PopupOpenTarget): void => callback(target)
      ipcRenderer.on(IpcChannel.UiOpen, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.UiOpen, listener)
      }
    }
  },
  progression: {
    agentStats: (filePath) => ipcRenderer.invoke(IpcChannel.ProgressionAgentStats, filePath),
    agentsSummary: () => ipcRenderer.invoke(IpcChannel.ProgressionAgentsSummary),
    achievements: () => ipcRenderer.invoke(IpcChannel.ProgressionAchievements),
    equip: (change) => ipcRenderer.invoke(IpcChannel.ProgressionEquip, change),
    markAchievementsSeen: () => ipcRenderer.invoke(IpcChannel.ProgressionMarkSeen),
    onChanged: (callback) => {
      const listener = (): void => callback()
      ipcRenderer.on(IpcChannel.ProgressionChanged, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.ProgressionChanged, listener)
      }
    },
    onUnlocked: (callback) => {
      const listener = (_event: IpcRendererEvent, notice: UnlockNotice): void => callback(notice)
      ipcRenderer.on(IpcChannel.ProgressionUnlocked, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.ProgressionUnlocked, listener)
      }
    }
  },
  bosses: {
    list: () => ipcRenderer.invoke(IpcChannel.BossesList),
    pickIdle: () => ipcRenderer.invoke(IpcChannel.BossesPickIdle),
    sliceIdle: (sourceToken, columns, rows, cells) =>
      ipcRenderer.invoke(IpcChannel.BossesSliceIdle, sourceToken, columns, rows, cells),
    dropSources: () => ipcRenderer.invoke(IpcChannel.BossesDropSources),
    pickBackground: () => ipcRenderer.invoke(IpcChannel.BossesPickBackground),
    create: (draft) => ipcRenderer.invoke(IpcChannel.BossesCreate, draft),
    update: (id, draft) => ipcRenderer.invoke(IpcChannel.BossesUpdate, id, draft),
    remove: (id) => ipcRenderer.invoke(IpcChannel.BossesRemove, id),
    setInPool: (id, on) => ipcRenderer.invoke(IpcChannel.BossesSetInPool, id, on),
    onChanged: (callback) => {
      const listener = (): void => callback()
      ipcRenderer.on(IpcChannel.BossesChanged, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.BossesChanged, listener)
      }
    },
    fight: () => ipcRenderer.invoke(IpcChannel.BossesFight),
    onFight: (callback) => {
      const listener = (_event: IpcRendererEvent, fight: FightEvent): void => callback(fight)
      ipcRenderer.on(IpcChannel.BossesFightEvent, listener)
      return () => {
        ipcRenderer.removeListener(IpcChannel.BossesFightEvent, listener)
      }
    },
    fightOn: () => ipcRenderer.invoke(IpcChannel.BossesFightOn),
    dismiss: () => ipcRenderer.invoke(IpcChannel.BossesDismiss),
    getTestCommand: () => ipcRenderer.invoke(IpcChannel.BossesGetTestCommand),
    setTestCommand: (command) => ipcRenderer.invoke(IpcChannel.BossesSetTestCommand, command)
  },
  providers: {
    status: (force) => ipcRenderer.invoke(IpcChannel.ProvidersStatus, force === true),
    loginOAuth: (provider) => ipcRenderer.invoke(IpcChannel.ProvidersLoginOAuth, provider),
    cancelLogin: (provider) => ipcRenderer.invoke(IpcChannel.ProvidersCancelLogin, provider),
    saveApiKey: (provider, apiKey) =>
      ipcRenderer.invoke(IpcChannel.ProvidersSaveApiKey, provider, apiKey),
    logout: (provider) => ipcRenderer.invoke(IpcChannel.ProvidersLogout, provider),
    installCli: (provider) => ipcRenderer.invoke(IpcChannel.ProvidersInstallCli, provider)
  }
}

contextBridge.exposeInMainWorld('mya', api)
