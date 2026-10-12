// deno-lint-ignore-file no-explicit-any
// Phase 3: Daraja C2B confirmation endpoint.
// Design rules (see build prompt): store the raw payload first, answer
// Safaricom immediately with {"ResultCode":0,"ResultDesc":"Accepted"}, then
// process. Business rules (dedupe, matching) live in SQL; this function is a
// thin, neutral-named HTTP wrapper. No "mpesa"/"safaricom" words in the path.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Simple in-memory rate limiter per token (per-isolate; a first layer, not the only one).
const RATE_LIMIT = { windowMs: 60_000, max: 120 }
const hits = new Map<string, number[]>()

function rateLimited(token: string): boolean {
  const now = Date.now()
  const recent = (hits.get(token) ?? []).filter((t) => now - t < RATE_LIMIT.windowMs)
  recent.push(now)
  hits.set(token, recent)
  if (hits.size > 5_000) {
    for (const [key, times] of hits) {
      if (times.every((t) => now - t >= RATE_LIMIT.windowMs)) hits.delete(key)
    }
  }
  return recent.length > RATE_LIMIT.max
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  try {
    const url = new URL(req.url)
    const token = url.pathname.split('/').filter(Boolean).pop() ?? ''
    if (token.length < 32 || rateLimited(token)) {
      return new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    const contentType = req.headers.get('content-type') ?? ''
    if (!contentType.includes('application/json')) {
      return new Response(JSON.stringify({ error: 'unsupported_media_type' }), {
        status: 415,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    let payload: any
    try {
      payload = await req.json()
    } catch {
      return new Response(JSON.stringify({ error: 'invalid_json' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return new Response(JSON.stringify({ error: 'invalid_payload' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    // Look up the school by the sha256 hash of its callback token.
    const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
    const tokenHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')

    const { data: config, error: configError } = await supabase
      .from('school_mpesa_config')
      .select('school_id, shortcode')
      .eq('callback_token_hash', tokenHash)
      .maybeSingle()

    if (configError || !config) {
      // Unknown or guessed token: log it (without full payload details) and reject.
      await supabase.from('mpesa_callbacks_raw').insert({
        school_id: null,
        payload: { rejected: true, path_token_prefix: token.slice(0, 6) },
        processing_status: 'rejected',
      })
      return new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    // Reject payloads whose shortcode does not match the school the token belongs to.
    if (typeof payload.BusinessShortCode !== 'string' || payload.BusinessShortCode !== config.shortcode) {
      await supabase.from('mpesa_callbacks_raw').insert({
        school_id: config.school_id,
        payload: payload as any,
        processing_status: 'rejected',
      })
      return new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    // Store the raw callback untouched BEFORE any processing.
    const { data: stored, error: storeError } = await supabase
      .from('mpesa_callbacks_raw')
      .insert({ school_id: config.school_id, payload: payload as any })
      .select('id')
      .single()
    if (storeError || !stored) {
      // Only failure mode where we do not answer 0: Safaricom will retry.
      return new Response(JSON.stringify({ ResultCode: 1, ResultDesc: 'Try again later' }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    // Respond immediately; process after the response is on the wire.
    const body = JSON.stringify({ ResultCode: 0, ResultDesc: 'Accepted' })
    void (async () => {
      try {
        const { error } = await supabase.rpc('process_mpesa_callback', {
          target_callback_id: stored.id,
        })
        if (error) {
          await supabase
            .from('mpesa_callbacks_raw')
            .update({ processing_status: 'failed' })
            .eq('id', stored.id)
        }
      } catch {
        await supabase
          .from('mpesa_callbacks_raw')
          .update({ processing_status: 'failed' })
          .eq('id', stored.id)
      }
    })()

    return new Response(body, {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  } catch (_err) {
    return new Response(JSON.stringify({ error: 'internal_error' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }
})
