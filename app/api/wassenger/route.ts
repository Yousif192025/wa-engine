import { relayWassengerWebhook } from '../../../src/vercel-relay'

export const runtime = 'nodejs'
export const maxDuration = 15

export async function POST(request: Request): Promise<Response> {
  return relayWassengerWebhook(request, process.env, {
    log: (entry) => console.info(JSON.stringify(entry)),
  })
}
