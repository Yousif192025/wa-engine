import assert from 'node:assert/strict'
import test from 'node:test'
import { relayWassengerWebhook, type RelayEnvironment } from '../src/vercel-relay'

const environment: RelayEnvironment = {
  WA_ENGINE_URL: 'https://engine.example.test/webhooks/wassenger',
  WASSENGER_WEBHOOK_SECRET: 'wassenger-relay-secret-1234',
  ENGINE_WEBHOOK_SECRET: 'engine-relay-secret-567890',
  RELAY_TIMEOUT_MS: '8000',
}

function webhookRequest(secret = environment.WASSENGER_WEBHOOK_SECRET, body = '{"id":"event-001","event":"message:in:new","data":{"id":"message-001"}}') {
  return new Request('https://dashboard.example.test/api/wassenger', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-secret': secret!,
    },
    body,
  })
}

test('Vercel relay forwards the raw body and separate engine secret', async () => {
  const rawBody = '{"id":"event-001","event":"message:in:new","data":{"id":"message-001","body":"مرحبا"}}'
  let forwardedUrl = ''
  let forwardedInit: RequestInit | undefined
  const logs: Array<Record<string, unknown>> = []

  const response = await relayWassengerWebhook(webhookRequest(environment.WASSENGER_WEBHOOK_SECRET, rawBody), environment, {
    createRequestId: () => 'request-001',
    log: (entry) => logs.push(entry),
    fetchImpl: async (url, init) => {
      forwardedUrl = String(url)
      forwardedInit = init
      return new Response(null, { status: 202 })
    },
  })

  assert.equal(response.status, 202)
  assert.deepEqual(await response.json(), { accepted: true, requestId: 'request-001' })
  assert.equal(forwardedUrl, environment.WA_ENGINE_URL)
  assert.equal(forwardedInit?.body, rawBody)
  assert.equal((forwardedInit?.headers as Record<string, string>)['x-webhook-secret'], environment.ENGINE_WEBHOOK_SECRET)
  assert.equal((forwardedInit?.headers as Record<string, string>)['x-request-id'], 'request-001')
  assert.equal(logs[0]?.event, 'relay_completed')
  assert.equal(JSON.stringify(logs).includes(environment.ENGINE_WEBHOOK_SECRET!), false)
  assert.equal(JSON.stringify(logs).includes(environment.WASSENGER_WEBHOOK_SECRET!), false)
})

test('Vercel relay rejects an invalid Wassenger secret before forwarding', async () => {
  let called = false
  const response = await relayWassengerWebhook(webhookRequest('wrong-secret-value-12345'), environment, {
    fetchImpl: async () => {
      called = true
      return new Response(null, { status: 202 })
    },
  })

  assert.equal(response.status, 401)
  assert.equal(called, false)
})

test('Vercel relay maps an invalid downstream payload to HTTP 400', async () => {
  const response = await relayWassengerWebhook(webhookRequest(), environment, {
    createRequestId: () => 'request-invalid-payload',
    fetchImpl: async () => new Response(null, { status: 400 }),
  })

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'Invalid webhook payload', requestId: 'request-invalid-payload' })
})

test('Vercel relay returns HTTP 504 when wa-engine times out', async () => {
  const response = await relayWassengerWebhook(webhookRequest(), environment, {
    createRequestId: () => 'request-timeout',
    fetchImpl: async () => {
      throw new DOMException('timeout', 'TimeoutError')
    },
  })

  assert.equal(response.status, 504)
  assert.deepEqual(await response.json(), { error: 'Webhook relay timeout', requestId: 'request-timeout' })
})

test('Vercel relay stays unavailable when its secrets are missing', async () => {
  const response = await relayWassengerWebhook(webhookRequest(), { ...environment, ENGINE_WEBHOOK_SECRET: undefined })
  assert.equal(response.status, 503)
})

