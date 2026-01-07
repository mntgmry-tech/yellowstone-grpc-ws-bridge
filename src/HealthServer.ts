import express from 'express'
import type { Response } from 'express'
import type { ApiKeyCreateInput, ApiKeyStore, ApiKeyUpdateInput } from './apiKeys'
import type { BridgeMetricsSnapshot } from './BridgeServer'
import { NodeHealthMonitor } from './NodeHealthMonitor'
import type { StatsSnapshot } from './utils/stats'

type HealthServerConfig = {
  bind: string
  port: number
  monitor: NodeHealthMonitor
  statsProvider?: () => StatsSnapshot
  metricsProvider?: () => BridgeMetricsSnapshot
  apiKeyStore?: ApiKeyStore
  onApiKeyRevoked?: (apiKeyId: string) => void
}

export class HealthServer {
  private app = express()
  private server?: ReturnType<typeof this.app.listen>
  private metricSections = new Set([
    'clients',
    'caches',
    'grpc',
    'node',
    'rpc',
    'stats',
    'websocket',
    'server',
    'subscriptions'
  ])

  constructor(private config: HealthServerConfig) {
    this.app.disable('x-powered-by')
    this.app.use(express.json({ limit: '256kb' }))
    this.app.get('/health', (_req, res) => {
      const node = this.config.monitor.getStatus()
      const ok = node.ok
      res.status(ok ? 200 : 503).json({
        ok,
        now: new Date().toISOString(),
        uptimeSec: Math.floor(process.uptime()),
        node: {
          endpoint: this.config.monitor.getEndpoint(),
          ...node
        }
      })
    })

    this.app.get('/admin', (_req, res) => {
      res.type('html').send(this.renderMetricsPage())
    })

    this.app.get('/stats', (_req, res) => {
      if (!this.config.statsProvider) {
        res.status(503).json({ error: 'stats not available' })
        return
      }
      res.json(this.config.statsProvider())
    })

    this.app.get('/metrics', (_req, res) => {
      if (!this.config.metricsProvider) {
        res.status(503).json({ error: 'metrics not available' })
        return
      }
      res.json(this.config.metricsProvider())
    })

    this.app.get('/metrics/:section', (req, res) => {
      if (!this.config.metricsProvider) {
        res.status(503).json({ error: 'metrics not available' })
        return
      }
      const section = req.params.section
      if (!this.metricSections.has(section)) {
        res.status(404).json({ error: `unknown metrics section: ${section}` })
        return
      }
      const metrics = this.config.metricsProvider()
      const payload = metrics[section as keyof BridgeMetricsSnapshot]
      if (payload === undefined) {
        res.status(404).json({ error: `missing metrics section: ${section}` })
        return
      }
      res.json(payload)
    })

    this.app.get('/api-keys', async (_req, res) => {
      const store = this.getApiKeyStore(res)
      if (!store) return
      try {
        const keys = await store.list()
        res.json({ keys })
      } catch (error) {
        console.error('[api-keys] list failed', error)
        res.status(500).json({ error: 'failed to list api keys' })
      }
    })

    this.app.get('/api-keys/:id', async (req, res) => {
      const store = this.getApiKeyStore(res)
      if (!store) return
      try {
        const key = await store.get(req.params.id)
        if (!key) {
          res.status(404).json({ error: 'api key not found' })
          return
        }
        res.json(key)
      } catch (error) {
        console.error('[api-keys] get failed', error)
        res.status(500).json({ error: 'failed to fetch api key' })
      }
    })

    this.app.post('/api-keys', async (req, res) => {
      const store = this.getApiKeyStore(res)
      if (!store) return
      const body = req.body as Record<string, unknown>
      const userName = typeof body.userName === 'string' ? body.userName.trim() : ''
      const active = typeof body.active === 'boolean' ? body.active : undefined

      if (!userName) {
        res.status(400).json({ error: 'userName is required' })
        return
      }

      const payload: ApiKeyCreateInput = { userName, active }
      try {
        const created = await store.create(payload)
        res.status(201).json(created)
      } catch (error) {
        console.error('[api-keys] create failed', error)
        res.status(500).json({ error: 'failed to create api key' })
      }
    })

    this.app.patch('/api-keys/:id', async (req, res) => {
      const store = this.getApiKeyStore(res)
      if (!store) return
      const body = req.body as Record<string, unknown>
      const update: ApiKeyUpdateInput = {}

      if ('userName' in body) {
        if (typeof body.userName !== 'string' || !body.userName.trim()) {
          res.status(400).json({ error: 'userName must be a non-empty string' })
          return
        }
        update.userName = body.userName.trim()
      }

      if ('active' in body) {
        if (typeof body.active !== 'boolean') {
          res.status(400).json({ error: 'active must be a boolean' })
          return
        }
        update.active = body.active
      }

      if (Object.keys(update).length === 0) {
        res.status(400).json({ error: 'no fields provided to update' })
        return
      }

      try {
        const updated = await store.update(req.params.id, update)
        if (!updated) {
          res.status(404).json({ error: 'api key not found' })
          return
        }
        if (update.active === false) {
          this.config.onApiKeyRevoked?.(updated.id)
        }
        res.json(updated)
      } catch (error) {
        console.error('[api-keys] update failed', error)
        res.status(500).json({ error: 'failed to update api key' })
      }
    })

    this.app.delete('/api-keys/:id', async (req, res) => {
      const store = this.getApiKeyStore(res)
      if (!store) return
      try {
        const deleted = await store.delete(req.params.id)
        if (!deleted) {
          res.status(404).json({ error: 'api key not found' })
          return
        }
        this.config.onApiKeyRevoked?.(req.params.id)
        res.status(204).send()
      } catch (error) {
        console.error('[api-keys] delete failed', error)
        res.status(500).json({ error: 'failed to delete api key' })
      }
    })
  }

  start() {
    this.server = this.app.listen(this.config.port, this.config.bind, () => {
      console.log(
        `[health] listening on http://${this.config.bind}:${this.config.port} (health=/health stats=/stats metrics=/metrics ui=/admin)`
      )
    })
  }

  stop() {
    if (this.server) this.server.close()
    this.server = undefined
  }

  private getApiKeyStore(res: Response): ApiKeyStore | undefined {
    const store = this.config.apiKeyStore
    if (!store || !store.ready()) {
      res.status(503).json({ error: 'api key store unavailable' })
      return undefined
    }
    return store
  }

  private renderMetricsPage() {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Bridge Metrics</title>
    <style>
      :root {
        --bg-1: #f4efe5;
        --bg-2: #dfe8ea;
        --card: rgba(255, 255, 255, 0.85);
        --ink: #1f2428;
        --muted: #4b5563;
        --accent: #2f6f6f;
        --border: rgba(17, 24, 39, 0.12);
        --shadow: rgba(15, 23, 42, 0.15);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
        color: var(--ink);
        background: radial-gradient(circle at top left, var(--bg-2), var(--bg-1));
        min-height: 100vh;
        font-size: 16px;
      }

      header {
        display: flex;
        gap: 16px;
        align-items: center;
        justify-content: space-between;
        padding: 18px 24px 6px;
      }

      .title {
        font-size: 24px;
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }

      .title-block {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .subtitle {
        font-size: 14px;
        color: var(--muted);
      }

      .controls {
        display: flex;
        gap: 8px;
        align-items: center;
        font-size: 15px;
        color: var(--muted);
      }

      .controls input {
        width: 80px;
        padding: 4px 6px;
        border-radius: 6px;
        border: 1px solid var(--border);
        background: #fff;
      }

      .controls button {
        padding: 5px 10px;
        border-radius: 6px;
        border: 1px solid var(--border);
        background: #f6f6f6;
        cursor: pointer;
      }

      .controls button:hover {
        background: #ffffff;
      }

      .status {
        font-size: 15px;
        color: var(--muted);
      }

      main {
        padding: 10px 18px 24px;
        display: grid;
        gap: 12px;
        align-items: start;
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }

      .column {
        display: flex;
        flex-direction: column;
        gap: 12px;
        min-width: 0;
      }

      .card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 12px 14px;
        box-shadow: 0 10px 24px var(--shadow);
        animation: rise 250ms ease;
      }

      .card.slim {
        padding: 10px 12px;
      }

      @keyframes rise {
        from {
          opacity: 0;
          transform: translateY(6px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      .card h2 {
        font-size: 16px;
        margin: 0 0 8px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--accent);
      }

      .group {
        padding-top: 6px;
        margin-top: 6px;
        border-top: 1px dashed var(--border);
      }

      .group:first-of-type {
        border-top: 0;
        padding-top: 0;
        margin-top: 0;
      }

      .group-title {
        font-size: 14px;
        font-weight: 700;
        letter-spacing: 0.02em;
        color: var(--muted);
        margin-bottom: 4px;
      }

      dl {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 4px 10px;
        margin: 0;
      }

      dl.stacked {
        grid-template-columns: 1fr;
      }

      dl.stacked dd {
        padding-left: 12px;
      }

      dt {
        font-size: 14px;
        color: var(--muted);
      }

      dd {
        margin: 0;
        font-size: 15px;
        color: var(--ink);
        word-break: break-word;
      }

      dd dl {
        margin: 2px 0 0;
      }

      dl.nested {
        grid-template-columns: 1fr 1fr;
        gap: 2px 8px;
      }

      dl.nested dt {
        font-size: 13px;
      }

      dl.nested dd {
        font-size: 14px;
      }

      .clients {
        grid-column: 1 / -1;
      }

      .wide {
        grid-column: 1 / -1;
      }

      .stats-grid {
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        margin-top: 8px;
      }

      details {
        border-top: 1px dashed var(--border);
        padding-top: 6px;
        margin-top: 6px;
      }

      summary {
        cursor: pointer;
        font-size: 14px;
        color: var(--ink);
        display: flex;
        justify-content: space-between;
        gap: 12px;
      }

      .pill {
        padding: 1px 6px;
        border-radius: 999px;
        font-size: 10px;
        border: 1px solid var(--border);
        text-transform: uppercase;
      }

      .api-keys {
        padding: 0 18px 40px;
      }

      .api-keys-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;
      }

      .api-keys-header h2 {
        margin: 0;
      }

      .api-keys-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--muted);
        font-size: 14px;
      }

      .api-keys-form {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 8px 12px;
        align-items: end;
        margin-bottom: 12px;
      }

      .api-keys-form .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .api-keys-form label {
        font-size: 12px;
        color: var(--muted);
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }

      .api-keys-form input[type="text"] {
        padding: 6px 8px;
        border-radius: 8px;
        border: 1px solid var(--border);
        background: #fff;
        font-size: 14px;
      }

      .api-keys-form .checkbox {
        display: flex;
        align-items: center;
        gap: 6px;
        color: var(--muted);
        font-size: 13px;
        padding-bottom: 4px;
      }

      .api-keys-table-wrap {
        overflow-x: auto;
      }

      .api-keys-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 14px;
      }

      .api-keys-table th,
      .api-keys-table td {
        text-align: left;
        padding: 6px 8px;
        border-bottom: 1px dashed var(--border);
        vertical-align: middle;
      }

      .api-keys-table th {
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }

      .api-keys-table input[type="text"] {
        width: 100%;
        padding: 4px 6px;
        border-radius: 6px;
        border: 1px solid var(--border);
        background: #fff;
        font-size: 13px;
      }

      .api-keys-table code {
        font-family: "Courier New", Courier, monospace;
        font-size: 12px;
      }

      .api-keys-actions button,
      .api-keys-form button,
      .api-keys-table button {
        padding: 5px 10px;
        border-radius: 6px;
        border: 1px solid var(--border);
        background: #f6f6f6;
        cursor: pointer;
      }

      .api-keys-actions button:hover,
      .api-keys-form button:hover,
      .api-keys-table button:hover {
        background: #ffffff;
      }

      .api-keys-row-actions {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }

      @media (max-width: 1500px) {
        main {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
      }

      @media (max-width: 980px) {
        main {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }

      @media (max-width: 680px) {
        main {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="title-block">
        <div class="title">Yellowstone WS Bridge Metrics</div>
        <div class="subtitle" id="server-meta">startedAt - • uptime -</div>
      </div>
      <div class="controls">
        <label for="interval">Refresh (ms)</label>
        <input id="interval" type="number" min="1000" step="1000" />
        <button id="apply">Apply</button>
        <span class="status" id="status">Idle</span>
      </div>
    </header>

    <main id="grid"></main>

    <section class="api-keys" id="api-keys">
      <div class="card">
        <div class="api-keys-header">
          <h2>API Keys</h2>
          <div class="api-keys-actions">
            <button id="api-refresh">Refresh</button>
            <span class="status" id="api-key-status">Idle</span>
          </div>
        </div>
        <div class="api-keys-form">
          <div class="field">
            <label for="api-user-name">User Name</label>
            <input id="api-user-name" type="text" placeholder="Jane Doe" />
          </div>
          <label class="checkbox" for="api-active">
            <input id="api-active" type="checkbox" checked />
            Active
          </label>
          <button id="api-create">Create Key</button>
        </div>
        <div class="api-keys-table-wrap">
          <table class="api-keys-table">
            <thead>
              <tr>
                <th>User Name</th>
                <th>User Id</th>
                <th>API Key</th>
                <th>Created</th>
                <th>Last Used</th>
                <th>Active</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="api-keys-body"></tbody>
          </table>
        </div>
      </div>
    </section>

    <script>
      const DEFAULT_INTERVAL = 15000
      const MIN_INTERVAL = 1000
      const MAX_INTERVAL = 60000
      const expandedKey = 'metricsExpandedClients'

      const intervalInput = document.getElementById('interval')
      const applyBtn = document.getElementById('apply')
      const statusEl = document.getElementById('status')
      const gridEl = document.getElementById('grid')
      const serverMetaEl = document.getElementById('server-meta')
      const apiKeyStatusEl = document.getElementById('api-key-status')
      const apiRefreshBtn = document.getElementById('api-refresh')
      const apiCreateBtn = document.getElementById('api-create')
      const apiUserNameInput = document.getElementById('api-user-name')
      const apiActiveInput = document.getElementById('api-active')
      const apiKeysBody = document.getElementById('api-keys-body')

      const storedExpanded = localStorage.getItem(expandedKey)
      const expandedIds = new Set(storedExpanded ? JSON.parse(storedExpanded) : [])

      function saveExpanded() {
        localStorage.setItem(expandedKey, JSON.stringify(Array.from(expandedIds)))
      }

      function parseInterval(value) {
        const n = Number(value)
        if (!Number.isFinite(n)) return DEFAULT_INTERVAL
        return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.floor(n)))
      }

      function loadInterval() {
        const params = new URLSearchParams(window.location.search)
        const qp = params.get('interval')
        if (qp) return parseInterval(qp)
        const stored = localStorage.getItem('metricsIntervalMs')
        return stored ? parseInterval(stored) : DEFAULT_INTERVAL
      }

      let intervalMs = loadInterval()
      intervalInput.value = intervalMs

      let timer = null

      function setIntervalMs(value) {
        intervalMs = parseInterval(value)
        intervalInput.value = intervalMs
        localStorage.setItem('metricsIntervalMs', String(intervalMs))
        if (timer) clearInterval(timer)
        timer = setInterval(tick, intervalMs)
      }

      applyBtn.addEventListener('click', () => setIntervalMs(intervalInput.value))

      async function tick() {
        if (document.visibilityState === 'hidden') return
        statusEl.textContent = 'Refreshing...'
        try {
          const res = await fetch('/metrics', { cache: 'no-store' })
          if (!res.ok) throw new Error('metrics fetch failed')
          const metrics = await res.json()
          render(metrics)
          statusEl.textContent =
            'Updated ' +
            new Date().toLocaleTimeString('en-US', {
              timeZone: 'America/Denver'
            })
        } catch (err) {
          statusEl.textContent = 'Error'
        }
      }

      function formatDateValue(value, key) {
        if (value === undefined || value === null) return undefined
        if (typeof value === 'string') {
          const parsed = Date.parse(value)
          if (!Number.isNaN(parsed)) {
            return new Date(parsed).toLocaleTimeString('en-US', { timeZone: 'America/Denver' })
          }
        }
        if (typeof value === 'number' && key) {
          const lower = key.toLowerCase()
          if (lower === 'now' || lower.endsWith('at') || lower.endsWith('time') || lower.endsWith('timestamp')) {
            const ms = value < 1e12 ? value * 1000 : value
            return new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/Denver' })
          }
        }
        return undefined
      }

      function formatTimestamp(value) {
        if (!value) return '-'
        const parsed = Date.parse(value)
        if (Number.isNaN(parsed)) return String(value)
        return new Date(parsed).toLocaleString('en-US', { timeZone: 'America/Denver' })
      }

      function setApiStatus(text) {
        if (!apiKeyStatusEl) return
        apiKeyStatusEl.textContent = text
      }

      async function loadApiKeys() {
        if (!apiKeysBody) return
        setApiStatus('Loading...')
        try {
          const res = await fetch('/api-keys', { cache: 'no-store' })
          if (!res.ok) throw new Error('api key fetch failed')
          const payload = await res.json()
          const keys = Array.isArray(payload.keys) ? payload.keys : []
          renderApiKeys(keys)
          setApiStatus(
            'Updated ' +
              new Date().toLocaleTimeString('en-US', {
                timeZone: 'America/Denver'
              })
          )
        } catch (err) {
          setApiStatus('Error')
        }
      }

      function renderApiKeys(keys) {
        if (!apiKeysBody) return
        apiKeysBody.innerHTML = ''
        if (!keys.length) {
          const row = document.createElement('tr')
          const cell = document.createElement('td')
          cell.colSpan = 7
          cell.textContent = 'No API keys found.'
          row.appendChild(cell)
          apiKeysBody.appendChild(row)
          return
        }

        keys.forEach((key) => {
          const row = document.createElement('tr')

          const userNameCell = document.createElement('td')
          const userNameInput = document.createElement('input')
          userNameInput.type = 'text'
          userNameInput.value = key.userName ?? ''
          userNameCell.appendChild(userNameInput)

          const userIdCell = document.createElement('td')
          const userIdText = document.createElement('code')
          userIdText.textContent = key.userId ?? ''
          userIdCell.appendChild(userIdText)

          const apiKeyCell = document.createElement('td')
          const apiKeyCode = document.createElement('code')
          apiKeyCode.textContent = key.apiKey ?? '-'
          apiKeyCell.appendChild(apiKeyCode)

          const createdCell = document.createElement('td')
          createdCell.textContent = formatTimestamp(key.createdAt)

          const lastUsedCell = document.createElement('td')
          lastUsedCell.textContent = formatTimestamp(key.lastUsed)

          const activeCell = document.createElement('td')
          const activeInput = document.createElement('input')
          activeInput.type = 'checkbox'
          activeInput.checked = Boolean(key.active)
          activeCell.appendChild(activeInput)

          const actionsCell = document.createElement('td')
          const actions = document.createElement('div')
          actions.className = 'api-keys-row-actions'
          const saveBtn = document.createElement('button')
          saveBtn.textContent = 'Save'
          saveBtn.addEventListener('click', () =>
            updateApiKey(key.id, {
              userName: userNameInput.value,
              active: activeInput.checked
            })
          )
          const deleteBtn = document.createElement('button')
          deleteBtn.textContent = 'Delete'
          deleteBtn.addEventListener('click', () => deleteApiKey(key.id))
          actions.appendChild(saveBtn)
          actions.appendChild(deleteBtn)
          actionsCell.appendChild(actions)

          row.appendChild(userNameCell)
          row.appendChild(userIdCell)
          row.appendChild(apiKeyCell)
          row.appendChild(createdCell)
          row.appendChild(lastUsedCell)
          row.appendChild(activeCell)
          row.appendChild(actionsCell)
          apiKeysBody.appendChild(row)
        })
      }

      async function createApiKey() {
        if (!apiCreateBtn || !apiUserNameInput || !apiActiveInput) return
        const userName = apiUserNameInput.value.trim()
        if (!userName) {
          setApiStatus('User name required')
          return
        }

        setApiStatus('Creating...')
        try {
          const res = await fetch('/api-keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userName,
              active: apiActiveInput.checked
            })
          })
          if (!res.ok) throw new Error('api key create failed')
          apiUserNameInput.value = ''
          apiActiveInput.checked = true
          await loadApiKeys()
        } catch (err) {
          setApiStatus('Error')
        }
      }

      async function updateApiKey(id, payload) {
        if (!id) return
        const userName = String(payload.userName ?? '').trim()
        if (!userName) {
          setApiStatus('User name required')
          return
        }
        setApiStatus('Saving...')
        try {
          const res = await fetch('/api-keys/' + encodeURIComponent(id), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userName,
              active: Boolean(payload.active)
            })
          })
          if (!res.ok) throw new Error('api key update failed')
          await loadApiKeys()
        } catch (err) {
          setApiStatus('Error')
        }
      }

      async function deleteApiKey(id) {
        if (!id) return
        if (!confirm('Delete this API key?')) return
        setApiStatus('Deleting...')
        try {
          const res = await fetch('/api-keys/' + encodeURIComponent(id), { method: 'DELETE' })
          if (!res.ok) throw new Error('api key delete failed')
          await loadApiKeys()
        } catch (err) {
          setApiStatus('Error')
        }
      }

      function renderGroup(container, label, data, options = {}) {
        if (!data || Object.keys(data).length === 0) return
        const hideTitle = Boolean(options.hideTitle)
        const stacked = Boolean(options.stacked)
        const group = document.createElement('div')
        group.className = 'group'
        if (!hideTitle) {
          const title = document.createElement('div')
          title.className = 'group-title'
          title.textContent = label
          group.appendChild(title)
        }
        const dl = document.createElement('dl')
        if (stacked) dl.classList.add('stacked')
        const entries = Object.entries(data)
        if (entries.length === 0) return
        entries.forEach(([key, value]) => {
          const dt = document.createElement('dt')
          dt.textContent = key
          const dd = document.createElement('dd')
          dd.appendChild(renderValue(value, key))
          dl.appendChild(dt)
          dl.appendChild(dd)
        })
        group.appendChild(dl)
        container.appendChild(group)
      }

      function renderValue(value, key, depth = 0) {
        if (value === undefined || value === null) return document.createTextNode('-')
        const dateValue = formatDateValue(value, key)
        if (dateValue) return document.createTextNode(dateValue)
        if (typeof value === 'number') {
          return document.createTextNode(Number.isFinite(value) ? value.toLocaleString() : String(value))
        }
        if (typeof value === 'boolean') return document.createTextNode(value ? 'true' : 'false')
        if (Array.isArray(value)) return document.createTextNode(value.join(', '))
        if (typeof value === 'object') {
          if (depth >= 2) return document.createTextNode(JSON.stringify(value))
          const dl = document.createElement('dl')
          dl.className = 'nested'
          Object.entries(value).forEach(([key, nestedValue]) => {
            const dt = document.createElement('dt')
            dt.textContent = key
            const dd = document.createElement('dd')
            dd.appendChild(renderValue(nestedValue, key, depth + 1))
            dl.appendChild(dt)
            dl.appendChild(dd)
          })
          return dl
        }
        return document.createTextNode(String(value))
      }

      function renderCard(title, groups) {
        const card = document.createElement('div')
        card.className = 'card'
        const h2 = document.createElement('h2')
        h2.textContent = title
        card.appendChild(h2)
        groups.forEach((group) => renderGroup(card, group.label, group.data))
        return card
      }

      function renderSlimCard(title, groups) {
        const card = renderCard(title, groups)
        card.classList.add('slim')
        return card
      }

      function renderClients(card, clients) {
        const summary = {
          connected: clients.connected,
          retained: clients.retained,
          total: clients.total,
          totalSeen: clients.totalSeen
        }
        renderGroup(card, 'summary', summary)

        const list = document.createElement('div')
        list.className = 'group'
        const title = document.createElement('div')
        title.className = 'group-title'
        title.textContent = 'details'
        list.appendChild(title)

        const byId = clients.byId || []
        if (!byId.length) {
          const empty = document.createElement('div')
          empty.textContent = 'No clients connected.'
          list.appendChild(empty)
          card.appendChild(list)
          return
        }

        byId.forEach((client) => {
          const details = document.createElement('details')
          details.dataset.clientId = client.id
          if (expandedIds.has(client.id)) details.open = true

          details.addEventListener('toggle', () => {
            if (details.open) {
              expandedIds.add(client.id)
            } else {
              expandedIds.delete(client.id)
            }
            saveExpanded()
          })

          const summary = document.createElement('summary')
          const idSpan = document.createElement('span')
          idSpan.textContent = client.id
          const status = document.createElement('span')
          status.className = 'pill'
          status.textContent = client.connected ? 'connected' : 'disconnected'
          summary.appendChild(idSpan)
          summary.appendChild(status)
          details.appendChild(summary)

          const body = document.createElement('div')
          renderGroup(body, 'session', {
            remote: client.remote,
            createdAt: client.createdAt,
            lastSeenAt: client.lastSeenAt,
            disconnectedAt: client.disconnectedAt,
            lastSentAt: client.lastSentAt
          })
          renderGroup(body, 'watchlist', client.watchlist)
          renderGroup(body, 'options', client.options)
          renderGroup(body, 'rateLimit', client.rateLimit)
          renderGroup(body, 'sent', client.sent)
          details.appendChild(body)
          list.appendChild(details)
        })

        card.appendChild(list)
      }

      function render(metrics) {
        gridEl.innerHTML = ''

        const filterGroups = (groups) => groups.filter((group) => group.data)

        if (serverMetaEl) {
          const startedAt = formatDateValue(metrics.server?.startedAt, 'startedAt') ?? '-'
          const uptime = metrics.server?.uptimeSec !== undefined ? metrics.server.uptimeSec + 's' : '-'
          serverMetaEl.textContent = 'startedAt ' + startedAt + ' • uptime ' + uptime
        }

        const nodeCard = renderCard(
          'node',
          filterGroups([
            {
              label: 'status',
              data: {
                endpoint: metrics.node?.endpoint,
                ok: metrics.node?.status?.ok,
                lastCheckedAt: metrics.node?.status?.lastCheckedAt,
                lastOkAt: metrics.node?.status?.lastOkAt,
                lastErrorAt: metrics.node?.status?.lastErrorAt,
                lastError: metrics.node?.status?.lastError
              }
            },
            { label: 'metrics', data: metrics.node?.metrics }
          ])
        )

        const grpcCard = renderCard(
          'grpc',
          filterGroups([
            {
              label: 'connection',
              data: {
                endpoint: metrics.grpc?.endpoint,
                wanted: metrics.grpc?.wanted,
                allowed: metrics.grpc?.allowed
              }
            },
            {
              label: 'streams',
              data: {
                processedConnected: metrics.grpc?.processed?.connected,
                processedHeadSlot: metrics.grpc?.processed?.headSlot,
                confirmedConnected: metrics.grpc?.confirmed?.connected,
                confirmedHeadSlot: metrics.grpc?.confirmed?.headSlot
              }
            },
            {
              label: 'blocksMeta',
              data: {
                lastSlot: metrics.grpc?.blocksMeta?.lastSlot,
                lastBlockTime: metrics.grpc?.blocksMeta?.lastBlockTime,
                lastUpdatedAt: metrics.grpc?.blocksMeta?.lastUpdatedAt
              }
            },
            { label: 'retry', data: metrics.grpc?.retry },
            { label: 'lastStop', data: metrics.grpc?.lastStop }
          ])
        )

        const rpcCard = renderCard(
          'rpc',
          filterGroups([
            { label: 'healthCheck', data: metrics.rpc?.healthCheck },
            { label: 'tokenAccountLookup', data: metrics.rpc?.tokenAccountLookup }
          ])
        )

        const websocketCard = renderCard(
          'websocket',
          filterGroups([
            { label: 'clients', data: metrics.websocket?.clients },
            { label: 'sent', data: metrics.websocket?.sent }
          ])
        )

        const subscriptionsCard = renderCard(
          'subscriptions',
          filterGroups([{ label: 'watchlists', data: metrics.subscriptions }])
        )

        const cachesCard = renderCard(
          'caches',
          filterGroups([
            { label: 'blockMeta', data: metrics.caches?.blockMeta },
            { label: 'tokenAccount', data: metrics.caches?.tokenAccount },
            { label: 'confirmedBuffer', data: metrics.caches?.confirmedBuffer },
            { label: 'backlog', data: metrics.caches?.backlog }
          ])
        )

        const columns = [
          [nodeCard, websocketCard, subscriptionsCard],
          [grpcCard, rpcCard],
          [cachesCard]
        ]

        columns.forEach((cards) => {
          const column = document.createElement('div')
          column.className = 'column'
          cards.forEach((card) => column.appendChild(card))
          gridEl.appendChild(column)
        })

        const statsCard = renderCard('stats', [])
        statsCard.classList.add('wide')
        const statsGrid = document.createElement('div')
        statsGrid.className = 'stats-grid'
        const statsGroups = filterGroups([
          {
            label: 'summary',
            data: {
              now: metrics.stats?.now,
              uptimeSec: metrics.stats?.uptimeSec,
              periodSec: metrics.stats?.periodSec,
              clients: metrics.stats?.clients,
              watchedAccounts: metrics.stats?.watchedAccounts,
              watchedMints: metrics.stats?.watchedMints
            }
          },
          { label: 'grpc', data: metrics.stats?.grpc },
          { label: 'totals', data: metrics.stats?.totals, stacked: true },
          { label: 'deltas', data: metrics.stats?.deltas, stacked: true },
          { label: 'last', data: metrics.stats?.last }
        ])

        const summaryGroup = statsGroups.find((group) => group.label === 'summary')
        const otherGroups = statsGroups.filter((group) => group.label !== 'summary')

        if (summaryGroup) {
          const summaryCard = renderSlimCard(summaryGroup.label, [])
          renderGroup(summaryCard, summaryGroup.label, summaryGroup.data, {
            hideTitle: true,
            stacked: summaryGroup.stacked
          })
          statsGrid.appendChild(summaryCard)
        }

        const headSlots = metrics.stats?.headSlots
        const blockMeta = metrics.stats?.blockMeta
        const hasHeadSlots = headSlots && Object.keys(headSlots).length > 0
        const hasBlockMeta = blockMeta && Object.keys(blockMeta).length > 0
        if (hasHeadSlots || hasBlockMeta) {
          const slotsCard = renderSlimCard('slots', [])
          renderGroup(slotsCard, 'headSlots', headSlots)
          renderGroup(slotsCard, 'blockMeta', blockMeta)
          statsGrid.appendChild(slotsCard)
        }

        otherGroups.forEach((group) => {
          const subCard = renderSlimCard(group.label, [])
          renderGroup(subCard, group.label, group.data, { hideTitle: true, stacked: group.stacked })
          statsGrid.appendChild(subCard)
        })
        statsCard.appendChild(statsGrid)
        gridEl.appendChild(statsCard)

        const clientsCard = renderCard('clients', [])
        clientsCard.classList.add('clients')
        renderClients(clientsCard, metrics.clients || { byId: [] })
        gridEl.appendChild(clientsCard)
      }

      if (apiRefreshBtn) apiRefreshBtn.addEventListener('click', () => loadApiKeys())
      if (apiCreateBtn) apiCreateBtn.addEventListener('click', () => createApiKey())

      setIntervalMs(intervalMs)
      tick()
      loadApiKeys()
    </script>
  </body>
</html>`
  }
}
