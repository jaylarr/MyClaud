import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ExtraProps } from 'react-markdown'
import type { ProjectInfo } from '../../../shared/ipc'
import { splitFenced } from '../../../shared/composerMessage'
import { toolLabel, type ToolLabel } from '../../../shared/toolLabel'
import type {
  CallTarget,
  Conversation,
  ConversationItem,
  ConversationStatus,
  OutgoingImage,
  ToolItem
} from '../hooks/useConversation'
import { useAgents } from '../hooks/useAgents'
import { useAgentProgress, useProgression } from '../hooks/useProgression'
import { accessoryById } from '../progression/accessories'
import { achievementForReward } from '../../../shared/achievements'
import { useChatTheme } from '../hooks/useChatTheme'
import { useModelChoice } from '../hooks/useModelChoice'
import { replyTag, type ModelLists } from '../../../shared/models'
import ModelPicker from '../components/ModelPicker'
import ThemeBackdrop from '../components/ThemeBackdrop'
import ThemePicker from '../components/ThemePicker'
import { usePartyPanelMode } from '../hooks/usePartyPanelMode'
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion'
import { useActiveMascot } from '../mascots/useActiveMascot'
import { loopFor, type MascotStateName } from '../mascots/types'
import { mascotState } from '../conversation/mascotState'
import { useHeldMascotState } from '../conversation/useHeldMascotState'
import { speakerName } from '../conversation/agentName'
import { errorText, STOPPED_TEXT } from '../../../shared/noticeText'
import { partyWork, taskViews, type TaskView } from '../conversation/agentWork'
import { callTargetOf } from '../conversation/callTarget'
import AgentChip from '../components/AgentChip'
import AgentTaskCard from '../components/AgentTaskCard'
import Composer from '../components/Composer'
import Dialog from '../components/Dialog'
import ToolCard from '../components/ToolCard'
import Mascot from '../components/Mascot'
import DialogueBox from '../components/DialogueBox'
import Markdown from '../components/Markdown'
import { MarkdownCodeBlock } from '../markdown/MarkdownElements'
import { toPlainText } from '../../../shared/plainText'
import PartyPanel, { type PartyTab } from '../components/PartyPanel'
import { FIGHT_ON_MESSAGE, type Fight } from '../../../shared/bosses'
import type { BossFightStore } from '../hooks/useBossFight'
import { useBosses } from '../bosses/useBosses'
import { fightPack as packForFight } from '../../../shared/bosses'
import { useRoundReplay } from '../bosses/useRoundReplay'
import BossTab from '../bosses/BossTab'
import { fileLabel } from '../bosses/fightView'
import BattleView from '../bosses/BattleView'
import { BattleNotice, BossEndCard } from '../bosses/BattleNotices'
import { BossFace, HpBar } from '../bosses/BossParts'
import './ConversationScreen.css'

type ConversationScreenProps = {
  project: ProjectInfo
  conversation: Conversation
  // The agent called for my next message, held in App so AGENTS and INBOX can set it.
  call: CallTarget | null
  onCallChange: (call: CallTarget | null) => void
  // Changes when another screen wants the input focused.
  focusRequest: number
  onOpenTask: (taskId: string, section?: 'activity') => void
  onModelChange?: (model: string) => void
  // The open conversation's boss fight, and the party panel's tab (kept by the app).
  boss: BossFightStore
  partyTab: PartyTab
  onPartyTab: (tab: PartyTab) => void
}

// Consecutive tool cards share one wrapping row, as in the mockup. Tool calls
// made inside a task are its activity and show on its card instead.
type Block =
  { kind: 'item'; item: ConversationItem } | { kind: 'tools'; id: number; tools: ToolItem[] }

function toBlocks(items: ConversationItem[]): Block[] {
  const blocks: Block[] = []
  for (const item of items) {
    if (item.kind === 'tool' && item.taskId !== null) continue
    const last = blocks[blocks.length - 1]
    if (item.kind === 'tool') {
      if (last?.kind === 'tools') last.tools.push(item)
      else blocks.push({ kind: 'tools', id: item.id, tools: [item] })
    } else {
      blocks.push({ kind: 'item', item })
    }
  }
  return blocks
}

type HastNode = NonNullable<ExtraProps['node']>

// The tree react-markdown would hand the code box for a fenced block, so my pasted
// code is drawn by the very same component as a reply's.
function codeNode(text: string, language: string | null): HastNode {
  return {
    type: 'element',
    tagName: 'pre',
    properties: {},
    children: [
      {
        type: 'element',
        tagName: 'code',
        properties: language ? { className: [`language-${language}`] } : {},
        children: [{ type: 'text', value: text }]
      }
    ]
  }
}

// My own message is plain text. Only a fenced code block, which a big paste turns
// into, is drawn as the code box replies use: its lines do not wrap, the box scrolls
// sideways, and it has COPY.
function UserText({ text }: { text: string }): React.JSX.Element {
  const segments = useMemo(() => splitFenced(text), [text])
  if (!segments.some((segment) => segment.kind === 'code')) return <span>{text}</span>
  return (
    <>
      {segments.map((segment, i) =>
        segment.kind === 'text' ? (
          <span key={i}>{segment.text}</span>
        ) : (
          <div key={i} className="md conversation__code">
            <MarkdownCodeBlock node={codeNode(segment.text, segment.language)}>
              <code>{segment.text}</code>
            </MarkdownCodeBlock>
          </div>
        )
      )}
    </>
  )
}

type HistoryProps = {
  items: ConversationItem[]
  projectPath: string
  views: Map<string, TaskView>
  note: Conversation['historyNote']
  onOpenTask: (taskId: string, section?: 'activity') => void
  // The models, to name the model on each reply's tag.
  lists: ModelLists | null
  // Battle notices and end cards, each placed after its test run's tool card or task.
  battle: BattleEntry[]
}

// A battle notice or end card in the history. anchor is 'tool:<id>' or 'task:<id>'.
export type BattleEntry = { key: string; anchor: string | null; node: React.ReactNode }

function anchorsOf(block: Block): string[] {
  if (block.kind === 'tools') return block.tools.map((tool) => `tool:${tool.toolId}`)
  return block.item.kind === 'task' ? [`task:${block.item.taskId}`] : []
}

function HistoryList({
  items,
  projectPath,
  views,
  note,
  onOpenTask,
  lists,
  battle
}: HistoryProps): React.JSX.Element {
  const blocks = toBlocks(items)
  // An entry goes after its card; one whose card is not in the history goes at the end.
  const present = new Set(blocks.flatMap(anchorsOf))
  const placed = new Map<string, BattleEntry[]>()
  const loose: BattleEntry[] = []
  for (const entry of battle) {
    if (entry.anchor !== null && present.has(entry.anchor)) {
      placed.set(entry.anchor, [...(placed.get(entry.anchor) ?? []), entry])
    } else {
      loose.push(entry)
    }
  }
  const after = (block: Block): React.ReactNode[] =>
    anchorsOf(block).flatMap((anchor) =>
      (placed.get(anchor) ?? []).map((entry) => <Fragment key={entry.key}>{entry.node}</Fragment>)
    )
  return (
    <>
      {note === 'truncated' && (
        <p className="conversation__muted">Earlier messages are not shown.</p>
      )}
      {note === 'unavailable' && (
        <p className="conversation__muted">Earlier messages are not available.</p>
      )}
      {blocks.map((block) => (
        <Fragment key={block.kind === 'tools' ? `t${block.id}` : `i${block.item.id}`}>
          {renderBlock(block)}
          {after(block)}
        </Fragment>
      ))}
      {loose.map((entry) => (
        <Fragment key={entry.key}>{entry.node}</Fragment>
      ))}
    </>
  )

  function renderBlock(block: Block): React.ReactNode {
    if (block.kind === 'tools') {
      return (
        <div key={block.id} className="conversation__tools">
          {block.tools.map((tool) => (
            <ToolCard
              key={tool.id}
              name={tool.name}
              input={tool.input}
              state={tool.state}
              projectPath={projectPath}
            />
          ))}
        </div>
      )
    }
    const { item } = block
    switch (item.kind) {
      case 'user': {
        // A saved conversation does not keep the pictures, only how many there were.
        const missing = item.imageCount - item.images.length
        return (
          <div key={item.id} className="conversation__mine">
            {item.call && <AgentChip agent={item.call} />}
            {item.images.length > 0 && (
              <div className="conversation__images">
                {item.images.map((url) => (
                  <img key={url} className="conversation__image" src={url} alt="Pasted image" />
                ))}
              </div>
            )}
            {missing > 0 && (
              <span className="conversation__attached">
                {missing} {missing === 1 ? 'image' : 'images'} attached
              </span>
            )}
            {/* A message of images alone has no text line. */}
            {item.text.trim() !== '' && <UserText text={item.text} />}
            {item.delivery === 'queued' && <span className="conversation__delivery">QUEUED</span>}
            {item.delivery === 'not_delivered' && (
              <span className="conversation__undelivered">Not delivered. The run ended.</span>
            )}
          </div>
        )
      }
      case 'text': {
        const tag = item.meta ? replyTag(item.meta, lists) : ''
        return (
          <div key={item.id} className="conversation__reply">
            {tag !== '' && <span className="conversation__tag">{tag}</span>}
            <Markdown source={item.text} />
          </div>
        )
      }
      case 'task': {
        const view = views.get(item.taskId)
        return view ? <AgentTaskCard key={item.id} view={view} onOpen={onOpenTask} /> : null
      }
      case 'notice':
        if (item.notice.type === 'stopped') {
          return (
            <p key={item.id} className="conversation__stopped">
              {STOPPED_TEXT}
            </p>
          )
        }
        if (item.notice.type === 'info') {
          return (
            <p key={item.id} className="conversation__muted">
              {item.notice.text}
            </p>
          )
        }
        return (
          <p key={item.id} className="conversation__error">
            {errorText(item.notice.error)}
          </p>
        )
      default:
        return null
    }
  }
}

// Re-renders only when the items it shows change, not while the box types.
const History = memo(
  HistoryList,
  (a, b) =>
    a.projectPath === b.projectPath &&
    a.note === b.note &&
    a.views === b.views &&
    a.lists === b.lists &&
    a.onOpenTask === b.onOpenTask &&
    a.battle === b.battle &&
    a.items.length === b.items.length &&
    a.items.every((item, i) => item === b.items[i])
)

const STATUS_LABELS: Partial<Record<ConversationStatus, string>> = {
  running: 'RUNNING',
  waiting: 'WAITING FOR APPROVAL',
  done: 'DONE',
  error: 'ERROR'
}

// Corner badges from designs/6-mascot-states.html.
const BADGES: Partial<Record<MascotStateName, string>> = {
  thinking: '...',
  talking: 'Aa',
  working: '>_',
  asking: '?',
  victory: '!',
  hurt: '><'
}

// How close to the bottom (px) still counts as "at the bottom" for auto-scroll.
const STICK_THRESHOLD = 24

// The most agents working at once. Main refuses a call past this, and Claude
// Code's own limit is set to the same.
const MAX_AGENTS = 3

// The CHAT screen from designs/8-chat-party.html: the header, then the history
// and the stage in one frame with the input box under it, and the party panel on
// the right.
function ConversationScreen({
  project,
  conversation,
  call,
  onCallChange,
  focusRequest,
  onOpenTask,
  onModelChange,
  boss,
  partyTab,
  onPartyTab
}: ConversationScreenProps): React.JSX.Element {
  const { items, status, running, send, stop, answerPermission, loadHistory, newChat } =
    conversation
  const reducedMotion = usePrefersReducedMotion()
  const mascot = useActiveMascot(window.mya.mascots)
  const { agents, loaded: agentsLoaded } = useAgents(project.path)
  const progress = useAgentProgress(agents)
  // The equipped title and accessory: the title under the state caption, the
  // accessory drawn over the mascot.
  const { equipped } = useProgression()
  const accessory = accessoryById(equipped.accessory)
  const title = equipped.title
    ? (achievementForReward('title', equipped.title)?.reward.name ?? null)
    : null
  const { mode, toggle } = usePartyPanelMode()
  const modelChoice = useModelChoice(project.path)
  // The name the conversation speaks under: the mascot's, or the active provider (Codex, Gemini, Claude).
  const speaker = speakerName(mascot, modelChoice.choice.model)

  useEffect(() => {
    onModelChange?.(modelChoice.choice.model)
  }, [modelChoice.choice.model, onModelChange])
  const chatTheme = useChatTheme(project.path)
  const [themeOpen, setThemeOpen] = useState(false)
  const [typing, setTyping] = useState(false)
  const [confirmNew, setConfirmNew] = useState(false)
  const [newChatError, setNewChatError] = useState<string | null>(null)
  const historyRef = useRef<HTMLDivElement>(null)
  // The input box's text, so focus can be moved there from outside it.
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const stickToBottom = useRef(true)
  // Bumped when the input should take focus once the screen has settled.
  const [inputFocus, setInputFocus] = useState(0)
  // Boss battles: the packs, the replay of the latest round, the battle view (open on the
  // live fight, or read-only on a finished one), and text a weak point puts in the box.
  // A fight is drawn only once main has listed the bosses: a custom boss is never shown as The
  // Red Suite while the list is on its way. A boss that was deleted is drawn as The Red Suite.
  const { packs, loaded: bossesLoaded } = useBosses()
  const { current: fight, past: pastFights, fightOn: resumeFight, dismiss: dismissFight } = boss
  const fightPack = fight && bossesLoaded ? packForFight(packs, fight) : null
  const replayView = useRoundReplay(fight, boss.replay, reducedMotion)
  // live: the fight it was opened on (its start time), so a later fight never opens the
  // view by itself and an ended conversation shows CHAT again.
  const [battle, setBattle] = useState<{ readOnly: Fight | null; live: number | null } | null>(null)
  const [insert, setInsert] = useState<{ text: string; tick: number } | null>(null)
  const battleFight = battle
    ? (battle.readOnly ?? (fight && fight.startedAt === battle.live ? fight : null))
    : null
  const battlePack = battleFight && bossesLoaded ? packForFight(packs, battleFight) : null
  const battleOpen = battleFight !== null && battlePack !== null

  // The saved conversation comes back once per project, when nothing is in memory.
  useEffect(() => {
    loadHistory(project.path)
  }, [project.path, loadHistory])

  useEffect(() => {
    if (focusRequest > 0) inputRef.current?.focus()
  }, [focusRequest])

  // After NEW CHAT the confirm dialog closes and hands focus back to the header button
  // that opened it. The input takes it from there, a frame later.
  useEffect(() => {
    if (inputFocus === 0) return
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [inputFocus])

  const views = useMemo(() => taskViews(items, project.path), [items, project.path])
  const work = useMemo(() => partyWork(views), [views])

  const target = mascotState({ items, status, typing, mood: boss.mood })
  const shownState = useHeldMascotState(target)
  const loop = loopFor(mascot, shownState)

  // The last item shows in the dialogue box instead of the history when it is
  // reply text or a notice. It moves up once something comes after it.
  const last = items[items.length - 1]
  const boxItem = last && (last.kind === 'text' || last.kind === 'notice') ? last : null
  const historyItems = useMemo(() => (boxItem ? items.slice(0, -1) : items), [items, boxItem])
  // The tag of the reply in the dialogue box: the model that answered and the level.
  const boxTag =
    boxItem?.kind === 'text' && boxItem.meta ? replyTag(boxItem.meta, modelChoice.lists) : ''
  const hasReplies = items.some((item) => item.kind === 'text')

  // Requests from the main conversation and from agents together, oldest first.
  const pending = useMemo(
    () =>
      items.filter((item): item is ToolItem => item.kind === 'tool' && item.permission !== null),
    [items]
  )
  const askingTask = pending[0]?.taskId ? views.get(pending[0].taskId) : undefined
  const asker = askingTask ? askingTask.item.agent : null

  // Agents working or waiting for me. At three, nobody else can be called.
  const openAgents = [...views.values()].filter((view) => view.state !== 'ended').length
  const full = openAgents >= MAX_AGENTS

  // An agent at work names itself: "<agent> is working: Reading src/auth.js". With
  // more than one at work: "2 agents are working".
  let working: ToolLabel | null = null
  const busyTasks = [...views.values()].filter((view) => view.state === 'working')
  const busyTask = busyTasks[busyTasks.length - 1]
  if (busyTasks.length > 1) {
    working = { verb: `${busyTasks.length} agents are working`, target: null }
  } else if (busyTask) {
    const name = busyTask.item.agent.name
    working = busyTask.activity
      ? { verb: `${name} is working:`, target: busyTask.activity }
      : { verb: `${name} is working...`, target: null }
  } else {
    const runningTool = [...items]
      .reverse()
      .find(
        (item): item is ToolItem =>
          item.kind === 'tool' && item.taskId === null && item.state === 'running'
      )
    if (runningTool) working = toolLabel(runningTool.name, runningTool.input, project.path)
  }

  // For screen readers: the latest reply text block that is complete. A block is
  // complete once something follows it or the run has ended.
  const announced = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]
      if (item.kind === 'text' && (i < items.length - 1 || !running)) return item.text
    }
    return ''
  }, [items, running])
  // Read as plain text, so no Markdown marks are read out.
  const announce = useMemo(() => toPlainText(announced), [announced])

  // Keep the history scrolled to the bottom while it grows, unless the user scrolled up.
  useEffect(() => {
    const el = historyRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [historyItems, views])

  function handleScroll(): void {
    const el = historyRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD
  }

  // Sending works during a run too: main puts the message into the run, and Claude
  // reads it once the agent that is working has finished.
  function submit(message: string, images: OutgoingImage[]): void {
    if (message.trim() === '' && images.length === 0) return
    stickToBottom.current = true
    send(message, call, images)
    // One agent per message: the chip clears after I send.
    onCallChange(null)
  }

  // Escape goes back to CHAT from the battle view, unless a dialog is open over it.
  useEffect(() => {
    if (!battleOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('[role="dialog"]')) return
      setBattle(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [battleOpen])

  // FIGHT ON: the boss that got away is active again, then the one message goes out.
  const fightOn = useCallback(async (): Promise<void> => {
    if (running) return
    if (await resumeFight()) {
      stickToBottom.current = true
      send(FIGHT_ON_MESSAGE, null, [])
    }
  }, [running, resumeFight, send])

  const liveStart = fight?.startedAt ?? null
  const toggleBattle = (): void => {
    setBattle((open) => (open && !open.readOnly ? null : { readOnly: null, live: liveStart }))
  }

  // The battle notices and end cards of this conversation's fights, oldest first.
  const battleEntries = useMemo(() => {
    const entries: BattleEntry[] = []
    const fights = [...pastFights, ...(fight ? [fight] : [])]
    fights.forEach((each, f) => {
      const pack = bossesLoaded ? packForFight(packs, each) : null
      if (!pack) return
      const ending =
        each.status === 'defeated'
          ? each.notices.map((n) => n.kind).lastIndexOf('victory')
          : each.status === 'escaped'
            ? each.notices.map((n) => n.kind).lastIndexOf('escape')
            : -1
      each.notices.forEach((notice, n) => {
        const anchor = notice.taskId
          ? `task:${notice.taskId}`
          : notice.toolId
            ? `tool:${notice.toolId}`
            : null
        entries.push({
          key: `battle-${f}-${each.startedAt}-${n}`,
          anchor,
          node: <BattleNotice pack={pack} notice={notice} />
        })
        if (n === ending) {
          entries.push({
            key: `battle-end-${f}-${each.startedAt}`,
            anchor,
            node: (
              <BossEndCard
                pack={pack}
                fight={each}
                running={running}
                onBattleLog={() => setBattle({ readOnly: each, live: null })}
                onFightOn={() => void fightOn()}
              />
            )
          })
        }
      })
    })
    return entries
  }, [pastFights, fight, packs, bossesLoaded, running, fightOn, setBattle])

  async function startNewChat(): Promise<void> {
    setConfirmNew(false)
    setBattle(null)
    const error = await newChat()
    setNewChatError(error ? error.message : null)
    if (!error) {
      stickToBottom.current = true
      // The new chat starts from the saved defaults, so the control changes with it.
      modelChoice.reload()
      // And with no theme of its own: it shows the default theme.
      chatTheme.reload()
      setInputFocus((tick) => tick + 1)
    }
  }

  const statusLabel = STATUS_LABELS[status]
  const badge = BADGES[shownState]
  const placeholder = call
    ? `Message for ${call.agent.name}...`
    : running
      ? `Message ${speaker} or call an agent...`
      : `Message ${speaker}...`

  return (
    <section className="conversation" aria-labelledby="conversation-title">
      <header className="conversation__header">
        <div className="conversation__heading">
          <h1 id="conversation-title" className="conversation__title">
            {speaker}
          </h1>
          <div className="conversation__subtitle">In {project.name}</div>
        </div>
        {statusLabel && (
          <span className={`conversation__status conversation__status--${status}`}>
            <span className="conversation__status-square" aria-hidden="true" />
            {statusLabel}
          </span>
        )}
        {/* Works during a run: a theme never touches the agent. */}
        <button
          type="button"
          className="button button--secondary conversation__theme"
          aria-haspopup="dialog"
          disabled={chatTheme.active === null}
          onClick={() => setThemeOpen(true)}
        >
          <span
            aria-hidden="true"
            className={`conversation__swatch${chatTheme.entry.kind === 'none' ? ' conversation__swatch--none' : ''}`}
          />
          THEME: {chatTheme.entry.name.toUpperCase()}
        </button>
        <button
          type="button"
          className="button button--secondary button--small conversation__new"
          disabled={running}
          onClick={() => setConfirmNew(true)}
        >
          NEW CHAT
        </button>
        {newChatError && (
          <p role="alert" className="conversation__header-error">
            {newChatError}
          </p>
        )}
      </header>

      <div className="conversation__body">
        <div className="conversation__main">
          {battleOpen && battleFight && battlePack ? (
            <BattleView
              fight={battleFight}
              pack={battlePack}
              view={
                battle?.readOnly
                  ? {
                      hp: battleFight.hp,
                      effect: null,
                      defeated: battleFight.status === 'defeated',
                      pops: [],
                      combo: null,
                      hitsBadge: null
                    }
                  : replayView
              }
              mascot={mascot}
              speaker={speaker}
              agents={agents}
              running={running}
              readOnly={battle?.readOnly !== null && battle?.readOnly !== undefined}
              onBack={() => setBattle(null)}
              onFightOn={() => void fightOn()}
            />
          ) : (
            <div className="conversation__frame">
              {/* The theme behind the history and the stage, under its fade. */}
              <ThemeBackdrop image={chatTheme.entry.image} fade={chatTheme.active?.fade ?? 0} />
              <div
                ref={historyRef}
                className="conversation__history"
                onScroll={handleScroll}
                aria-label="History"
              >
                <History
                  items={historyItems}
                  projectPath={project.path}
                  views={views}
                  note={conversation.historyNote}
                  onOpenTask={onOpenTask}
                  lists={modelChoice.lists}
                  battle={battleEntries}
                />
              </div>

              <div className="conversation__stage">
                <div className="stage__mascot">
                  <div className="stage__frame">
                    <Mascot
                      src={loop.src}
                      frames={loop.frames}
                      fps={loop.fps}
                      reverse={loop.reverse}
                      scale={2}
                      label={`Mascot, ${shownState}`}
                      accessory={accessory}
                    />
                    {badge && (
                      <span
                        className={`stage__badge stage__badge--${shownState}`}
                        aria-hidden="true"
                      >
                        {badge}
                      </span>
                    )}
                  </div>
                  <div className={`stage__tag stage__tag--${shownState}`}>
                    {shownState.toUpperCase()}
                  </div>
                  {title && <div className="stage__title">{title.toUpperCase()}</div>}
                </div>
                <DialogueBox
                  agentName={speaker}
                  reply={
                    boxItem?.kind === 'text'
                      ? { id: boxItem.id, text: boxItem.text, instant: boxItem.instant }
                      : null
                  }
                  notice={boxItem?.kind === 'notice' ? boxItem.notice : null}
                  tag={boxTag}
                  pending={pending}
                  asker={asker}
                  working={working}
                  running={running}
                  empty={items.length === 0}
                  announce={announce}
                  projectPath={project.path}
                  reducedMotion={reducedMotion}
                  onAnswer={answerPermission}
                  onTypingChange={setTyping}
                />
              </div>
            </div>
          )}

          <Composer
            key={project.path}
            label={call ? `Message for ${call.agent.name}` : `Message ${speaker}`}
            placeholder={placeholder}
            running={running}
            inputRef={inputRef}
            picker={
              <ModelPicker
                lists={modelChoice.lists}
                listFailed={modelChoice.listFailed}
                choice={modelChoice.choice}
                asDefault={modelChoice.asDefault}
                onAsDefaultChange={modelChoice.setAsDefault}
                onPick={modelChoice.pick}
                hasReplies={hasReplies}
                onOpen={() => {
                  if (modelChoice.listFailed) modelChoice.reload()
                }}
              />
            }
            agent={
              call && (
                <AgentChip
                  agent={call.agent}
                  onRemove={() => {
                    onCallChange(null)
                    // The button that had focus is gone with the chip.
                    inputRef.current?.focus()
                  }}
                />
              )
            }
            onSend={submit}
            onStop={stop}
            insert={insert}
          />
        </div>

        <PartyPanel
          agents={agents}
          loaded={agentsLoaded}
          call={call}
          onCall={(agent) => onCallChange(agent ? callTargetOf(agent) : null)}
          full={full}
          work={work}
          mode={mode}
          onToggle={toggle}
          onOpenTask={onOpenTask}
          progress={progress}
          tab={partyTab}
          onTab={onPartyTab}
          bossDot={fight?.status === 'active'}
          bossTab={
            <BossTab
              fight={fight}
              pack={fightPack}
              view={replayView}
              expanded={battleOpen && !battle?.readOnly}
              running={running}
              onToggleBattle={toggleBattle}
              onFightOn={() => void fightOn()}
              onDismiss={() => void dismissFight()}
              onWeakPoint={(file) =>
                setInsert((current) => ({
                  text: `Focus on ${fileLabel(file)}.`,
                  tick: (current?.tick ?? 0) + 1
                }))
              }
            />
          }
          railBoss={
            fight && fightPack ? (
              <button
                type="button"
                className="party__rail-boss"
                aria-label={`${fightPack.name}, ${replayView.hp} of ${fight.maxHp} tests left`}
                onClick={() => setBattle({ readOnly: null, live: liveStart })}
              >
                <BossFace pack={fightPack} size={64} />
                <HpBar hp={replayView.hp} maxHp={fight.maxHp} height={4} />
              </button>
            ) : null
          }
        />
      </div>

      {themeOpen && chatTheme.active && (
        <ThemePicker
          entries={chatTheme.entries}
          active={chatTheme.active}
          ownChoice={chatTheme.ownChoice}
          onApply={chatTheme.apply}
          onAdd={chatTheme.add}
          onRename={chatTheme.rename}
          onRemove={chatTheme.remove}
          onClose={() => setThemeOpen(false)}
        />
      )}

      {confirmNew && (
        <Dialog
          title="NEW CHAT?"
          onClose={() => setConfirmNew(false)}
          actions={
            <>
              <button
                type="button"
                className="button button--secondary"
                onClick={() => setConfirmNew(false)}
              >
                CANCEL
              </button>
              <button
                type="button"
                className="button button--primary"
                onClick={() => void startNewChat()}
              >
                NEW CHAT
              </button>
            </>
          }
        >
          <p>Start a new conversation? The current one is cleared from Mya.</p>
        </Dialog>
      )}
    </section>
  )
}

export default ConversationScreen
