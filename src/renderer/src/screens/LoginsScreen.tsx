import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type {
  CliProviderId,
  ProviderStatus,
  ProvidersStatusResult
} from '../../../shared/ipc'
import './LoginsScreen.css'

type BusyAction = 'oauth' | 'key' | 'logout' | 'install' | null

// Kept for the entire app session so switching tabs never flashes "CHECKING...".
let cachedProvidersStatus: ProvidersStatusResult | null = null

type CardProps = {
  title: string
  description: string
  oauthButtonLabel: string
  oauthHint: string
  keyPlaceholder: string
  keyHint: string
  status: ProviderStatus | null
  onStatusUpdate: (next: ProvidersStatusResult) => void
  provider: CliProviderId
}

function ProviderCard({
  title,
  description,
  oauthButtonLabel,
  oauthHint,
  keyPlaceholder,
  keyHint,
  status,
  onStatusUpdate,
  provider
}: CardProps): React.JSX.Element {
  const [busy, setBusy] = useState<BusyAction>(null)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const installed = status?.installed ?? false
  const loggedIn = status?.loggedIn ?? false
  const account = status?.account ?? null

  async function handleOAuthLogin(): Promise<void> {
    setBusy('oauth')
    setError(null)
    setNotice(null)
    try {
      const res = await window.mya.providers.loginOAuth(provider)
      onStatusUpdate(res.status)
      if (res.ok) {
        setNotice('Signed in with browser OAuth.')
      } else {
        setError(res.error)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Browser sign-in failed.')
    } finally {
      setBusy(null)
    }
  }

  async function handleCancelOAuth(): Promise<void> {
    await window.mya.providers.cancelLogin(provider)
    setBusy(null)
  }

  async function handleSaveKey(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (apiKey.trim() === '' || busy !== null) return
    setBusy('key')
    setError(null)
    setNotice(null)
    try {
      const res = await window.mya.providers.saveApiKey(provider, apiKey)
      onStatusUpdate(res.status)
      if (res.ok) {
        setApiKey('')
        setNotice('API key saved.')
      } else {
        setError(res.error)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save API key.')
    } finally {
      setBusy(null)
    }
  }

  async function handleLogout(): Promise<void> {
    setBusy('logout')
    setError(null)
    setNotice(null)
    try {
      const res = await window.mya.providers.logout(provider)
      onStatusUpdate(res.status)
      if (res.ok) {
        setNotice('Signed out.')
      } else {
        setError(res.error)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign out.')
    } finally {
      setBusy(null)
    }
  }

  async function handleInstallCli(): Promise<void> {
    setBusy('install')
    setError(null)
    setNotice(null)
    try {
      const res = await window.mya.providers.installCli(provider)
      onStatusUpdate(res.status)
      if (res.ok) {
        setNotice('CLI installed and ready.')
      } else {
        setError(res.error)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'CLI installation failed.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section
      className={`provider-card${loggedIn ? ' provider-card--signed-in' : ''}`}
      aria-labelledby={`provider-title-${provider}`}
    >
      <div className="provider-card__head">
        <h2 id={`provider-title-${provider}`} className="provider-card__title">
          {title}
        </h2>
        <span
          className={`provider-card__status provider-card__status--${loggedIn ? 'on' : 'off'}`}
        >
          <span className="provider-card__dot" aria-hidden="true" />
          {status === null ? 'CHECKING...' : loggedIn ? 'SIGNED IN' : 'NOT SIGNED IN'}
        </span>
      </div>

      <p className="provider-card__desc">{description}</p>

      <div className="provider-card__meta">
        {account?.name && (
          <div className="provider-card__meta-row">
            <span className="provider-card__meta-label">Account Name</span>
            <span className="provider-card__meta-value">{account.name}</span>
          </div>
        )}
        {account?.email && (
          <div className="provider-card__meta-row">
            <span className="provider-card__meta-label">Email</span>
            <span className="provider-card__meta-value">{account.email}</span>
          </div>
        )}
        {account?.plan && (
          <div className="provider-card__meta-row">
            <span className="provider-card__meta-label">Plan / Tier</span>
            <span className="provider-card__meta-value provider-card__meta-value--plan">
              {account.plan.toUpperCase()}
            </span>
          </div>
        )}
        {account?.organization && (
          <div className="provider-card__meta-row">
            <span className="provider-card__meta-label">Organization</span>
            <span className="provider-card__meta-value">{account.organization}</span>
          </div>
        )}
        {account?.activeUntil && (
          <div className="provider-card__meta-row">
            <span className="provider-card__meta-label">Active Until</span>
            <span className="provider-card__meta-value">{account.activeUntil}</span>
          </div>
        )}
        <div className="provider-card__meta-row">
          <span className="provider-card__meta-label">Auth Method</span>
          <span className="provider-card__meta-value">
            {status?.detail ?? (loggedIn ? 'Signed in' : 'None')}
          </span>
        </div>
        <div className="provider-card__meta-row">
          <span className="provider-card__meta-label">CLI Binary</span>
          <span className="provider-card__meta-value">
            {status === null
              ? 'Checking...'
              : installed
                ? `Installed${status.version ? ` (${status.version})` : ''}`
                : 'Not installed'}
          </span>
        </div>
      </div>

      {error && (
        <p role="alert" className="provider-card__error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="provider-card__notice">
          {notice}
        </p>
      )}

      {!installed && status !== null && (
        <div className="provider-card__section">
          <h3 className="provider-card__label">1. INSTALL CLI</h3>
          <p className="provider-card__hint">
            The {provider === 'codex' ? '@openai/codex' : '@google/gemini-cli'} package was not
            found on this machine. Install it directly without opening a terminal.
          </p>
          <div className="provider-card__actions">
            <button
              type="button"
              className="button button--primary"
              disabled={busy !== null}
              onClick={() => void handleInstallCli()}
            >
              {busy === 'install' ? 'INSTALLING...' : 'INSTALL CLI'}
            </button>
          </div>
        </div>
      )}

      <div className="provider-card__section">
        <h3 className="provider-card__label">BROWSER SIGN-IN (OAUTH)</h3>
        <p className="provider-card__hint">{oauthHint}</p>
        <div className="provider-card__actions">
          <button
            type="button"
            className={`button ${loggedIn ? 'button--secondary' : 'button--primary'}`}
            disabled={busy !== null || !installed}
            onClick={() => void handleOAuthLogin()}
          >
            {busy === 'oauth'
              ? 'WAITING FOR BROWSER...'
              : loggedIn
                ? `SWITCH / ${oauthButtonLabel}`
                : oauthButtonLabel}
          </button>
          {busy === 'oauth' && (
            <button
              type="button"
              className="button button--secondary"
              onClick={() => void handleCancelOAuth()}
            >
              CANCEL
            </button>
          )}
        </div>
      </div>

      <form className="provider-card__section" onSubmit={(e) => void handleSaveKey(e)}>
        <label htmlFor={`api-key-${provider}`} className="provider-card__label">
          OR SIGN IN WITH API KEY
        </label>
        <p className="provider-card__hint">{keyHint}</p>
        <div className="provider-card__key-row">
          <input
            id={`api-key-${provider}`}
            type={showKey ? 'text' : 'password'}
            className="provider-card__input"
            placeholder={keyPlaceholder}
            value={apiKey}
            disabled={busy !== null}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={() => setShowKey((v) => !v)}
          >
            {showKey ? 'HIDE' : 'SHOW'}
          </button>
          <button
            type="submit"
            className="button"
            disabled={busy !== null || apiKey.trim() === ''}
          >
            {busy === 'key' ? 'SAVING...' : 'SAVE KEY'}
          </button>
        </div>
      </form>

      {loggedIn && (
        <div className="provider-card__section">
          <div className="provider-card__actions">
            <button
              type="button"
              className="button button--danger"
              disabled={busy !== null}
              onClick={() => void handleLogout()}
            >
              {busy === 'logout' ? 'SIGNING OUT...' : 'SIGN OUT'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

function LoginsScreen(): React.JSX.Element {
  const [status, setStatus] = useState<ProvidersStatusResult | null>(cachedProvidersStatus)
  const [refreshing, setRefreshing] = useState(false)

  const updateStatus = useCallback((next: ProvidersStatusResult): void => {
    cachedProvidersStatus = next
    setStatus(next)
  }, [])

  const loadStatus = useCallback(
    (force: boolean): Promise<void> => {
      return window.mya.providers.status(force).then(
        (next) => {
          updateStatus(next)
          setRefreshing(false)
        },
        (err: unknown) => {
          console.error('Could not check provider status:', err)
          setRefreshing(false)
        }
      )
    },
    [updateStatus]
  )

  useEffect(() => {
    if (cachedProvidersStatus === null) {
      void loadStatus(false)
    }
  }, [loadStatus])

  function handleRefresh(): void {
    setRefreshing(true)
    void loadStatus(true)
  }

  return (
    <div className="logins">
      <header className="logins__head">
        <div>
          <h1 className="logins__title">LOGINS</h1>
          <p className="logins__subtitle">
            Sign in to OpenAI Codex or Google Gemini directly from MyClaud without opening a
            terminal.
          </p>
        </div>
        <button
          type="button"
          className="button button--secondary button--small"
          disabled={refreshing}
          onClick={handleRefresh}
        >
          {refreshing ? 'REFRESHING...' : 'REFRESH STATUS'}
        </button>
      </header>

      <div className="logins__grid">
        <ProviderCard
          provider="codex"
          title="OPENAI CODEX"
          description="Powers Codex models in the model picker and party agents."
          oauthButtonLabel="SIGN IN WITH CHATGPT"
          oauthHint="Opens your browser to sign in with your ChatGPT Plus, Pro, or Team subscription."
          keyPlaceholder="sk-..."
          keyHint="Paste an OpenAI API key to authenticate Codex without browser sign-in."
          status={status?.codex ?? null}
          onStatusUpdate={updateStatus}
        />

        <ProviderCard
          provider="gemini"
          title="GOOGLE GEMINI"
          description="Powers Gemini 4 Argon, Hydrogen, 3.8 Flash, and Gemini 2.5 in the model picker and party agents."
          oauthButtonLabel="SIGN IN WITH GOOGLE"
          oauthHint="Opens your browser to sign in with Google, or uses Antigravity CLI (Google AI Pro) automatically if installed."
          keyPlaceholder="AIza..."
          keyHint="Paste a Gemini API key from Google AI Studio to authenticate immediately."
          status={status?.gemini ?? null}
          onStatusUpdate={updateStatus}
        />
      </div>
    </div>
  )
}

export default LoginsScreen
