export type RelayEnvironment = NodeJS.ProcessEnv

export type RelayDependencies = {
  fetchImpl?: typeof fetch
  createRequestId?: () => string
  log?: (entry: Record<string, unknown>) => void
}

type RelayConfiguration = {
  engineUrl: string
  wassengerSecret: string
  engineSecret: string
  timeoutMs: number
}

const MIN_SECRET_LENGTH = 16
const DEFAULT_TIMEOUT_MS = 8_000
const MAX_TIMEOUT_MS = 15_000

function constantTimeEqual(left: string | null, right: string): boolean {
  if (!left || left.length !== right.length) return false

  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

function positiveTimeout(value: string | undefined): number {
  if (!value) return DEFAULT_TIMEOUT_MS
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > MAX_TIMEOUT_MS) {
    return DEFAULT_TIMEOUT_MS
  }
  return parsed
}

function readConfiguration(environment: RelayEnvironment): RelayConfiguration | null {
  const engineUrl = environment.WA_ENGINE_URL?.trim()
  const wassengerSecret = environment.WASSENGER_WEBHOOK_SECRET?.trim()
  const engineSecret = environment.ENGINE_WEBHOOK_SECRET?.trim()

  if (!engineUrl || !wassengerSecret || !engineSecret) return null
  if (wassengerSecret.length < MIN_SECRET_LENGTH || engineSecret.length < MIN_SECRET_LENGTH) return null

  try {
    const parsedUrl = new URL(engineUrl)
    if (parsedUrl.protocol !== 'https:' && parsedUrl.hostname !== 'localhost' && parsedUrl.hostname !== '127.0.0.1') {
      return null
    }
  } catch {
    return null
  }

  return {
    engineUrl,
    wassengerSecret,
    engineSecret,
    timeoutMs: positiveTimeout(environment.RELAY_TIMEOUT_MS),
  }
}

function eventIdFrom(rawBody: string): string | undefined {
  try {
    const value = JSON.parse(rawBody) as { id?: unknown; data?: { id?: unknown } }
    const candidate = value.id ?? value.data?.id
    return typeof candidate === 'string' && candidate.length <= 120 ? candidate : undefined
  } catch {
    return undefined
  }
}

function logRelay(log: RelayDependencies['log'], entry: Record<string, unknown>): void {
  log?.({ component: 'vercel_wassenger_relay', ...entry })
}

export async function relayWassengerWebhook(
  request: Request,
  environment: RelayEnvironment = process.env,
  dependencies: RelayDependencies = {},
): Promise<Response> {
  const configuration = readConfiguration(environment)
  if (!configuration) {
    logRelay(dependencies.log, { event: 'relay_misconfigured' })
    return Response.json({ error: 'Webhook relay is unavailable' }, { status: 503 })
  }

  if (!constantTimeEqual(request.headers.get('x-webhook-secret'), configuration.wassengerSecret)) {
    logRelay(dependencies.log, { event: 'relay_auth_rejected' })
    return Response.json({ error: 'Unauthorized webhook' }, { status: 401 })
  }

  const rawBody = await request.text()
  if (!rawBody) {
    return Response.json({ error: 'Invalid webhook payload' }, { status: 400 })
  }

  const requestId = dependencies.createRequestId?.() ?? crypto.randomUUID()
  const eventId = eventIdFrom(rawBody)
  const fetchImpl = dependencies.fetchImpl ?? fetch

  try {
    const engineResponse = await fetchImpl(configuration.engineUrl, {
      method: 'POST',
      headers: {
        'content-type': request.headers.get('content-type') ?? 'application/json',
        'x-request-id': requestId,
        'x-webhook-secret': configuration.engineSecret,
      },
      body: rawBody,
      signal: AbortSignal.timeout(configuration.timeoutMs),
    })

    logRelay(dependencies.log, {
      event: 'relay_completed',
      requestId,
      eventId,
      engineStatus: engineResponse.status,
    })

    if (engineResponse.status >= 200 && engineResponse.status < 300) {
      return Response.json({ accepted: true, requestId }, { status: 202 })
    }

    if (engineResponse.status === 400) {
      return Response.json({ error: 'Invalid webhook payload', requestId }, { status: 400 })
    }

    return Response.json({ error: 'Webhook relay downstream failure', requestId }, { status: 502 })
  } catch (error) {
    const timeout = error instanceof DOMException && error.name === 'TimeoutError'
    logRelay(dependencies.log, {
      event: timeout ? 'relay_timeout' : 'relay_network_failure',
      requestId,
      eventId,
    })
    return Response.json(
      { error: timeout ? 'Webhook relay timeout' : 'Webhook relay unavailable', requestId },
      { status: timeout ? 504 : 502 },
    )
  }
}
