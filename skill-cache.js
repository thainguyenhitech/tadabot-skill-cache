/**
 * Cloudflare Worker: Skill Catalog Cache Proxy
 *
 * Proxy Supabase skill_catalog queries, cache 1 ngày tại edge.
 * Purge cache khi admin update skill.
 *
 * Endpoints:
 *   GET  /skills?{supabase query params}  → cached Supabase response
 *   GET  /categories                       → cached categories + counts
 *   POST /purge?token=<SECRET>             → purge all skill cache
 *
 * Setup:
 *   1. Cloudflare Dashboard → Worker Settings → Variables:
 *      - SUPABASE_URL: https://qcwbqjyqjnloapsczayz.supabase.co
 *      - SUPABASE_ANON_KEY: <anon key>
 *      - PURGE_SECRET: random string
 *
 *   2. Custom domain (optional):
 *      skills-api.tadabot.io → this worker
 *
 * Deploy: cd workers && npx wrangler deploy -c wrangler-skill-cache.toml
 */

const CACHE_TTL = 86400 // 1 day
const STALE_TTL = 172800 // 2 days (serve stale while revalidate)
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Expose-Headers': 'content-range',
}

export default {
  async fetch(request, env, ctx) {
    try {
      // CORS preflight
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS })
      }

      const url = new URL(request.url)
      const path = url.pathname

      // Purge endpoint
      if (path === '/purge' && request.method === 'POST') {
        return handlePurge(request, env, url)
      }

      // Only GET for cache endpoints
      if (request.method !== 'GET') {
        return json({ error: 'Method not allowed' }, 405)
      }

      if (path === '/categories') {
        return handleCategories(request, env, ctx)
      }

      if (path === '/skills') {
        return handleSkills(request, env, url, ctx)
      }

      return json({ error: 'Not found' }, 404)
    } catch (e) {
      return json({ error: e.message, stack: e.stack }, 500)
    }
  },
}

// --- Handlers ---

async function handleSkills(request, env, url, ctx) {
  // Forward query params to Supabase REST API
  const supabaseUrl = `${env.SUPABASE_URL}/rest/v1/skill_catalog?${url.searchParams.toString()}`
  // Cache key must be same zone — use worker's own URL
  const cacheKey = new Request(url.toString(), { method: 'GET' })

  // Try cache first
  const cache = caches.default
  let response = await cache.match(cacheKey)
  if (response) {
    // Add cache hit header
    const headers = new Headers(response.headers)
    headers.set('x-cache', 'HIT')
    headers.set('x-cache-ttl', CACHE_TTL.toString())
    Object.entries(CORS_HEADERS).forEach(([k, v]) => headers.set(k, v))
    return new Response(response.body, { status: response.status, headers })
  }

  // Cache miss — fetch from Supabase
  const supabaseResp = await fetch(supabaseUrl, {
    headers: {
      'apikey': env.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
      'Accept': 'application/json',
      'Prefer': extractPrefer(url.searchParams),
    },
  })

  // Build cacheable response
  const body = await supabaseResp.text()
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': `public, max-age=${CACHE_TTL}, stale-while-revalidate=${STALE_TTL}`,
    'x-cache': 'MISS',
    ...CORS_HEADERS,
  }

  // Forward content-range header for count queries
  const contentRange = supabaseResp.headers.get('content-range')
  if (contentRange) headers['content-range'] = contentRange

  const resp = new Response(body, { status: supabaseResp.status, headers })

  // Only cache successful responses
  if (supabaseResp.ok) {
    const cacheResp = new Response(body, {
      status: supabaseResp.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_TTL}` },
    })
    if (contentRange) cacheResp.headers.set('content-range', contentRange)
    ctx.waitUntil(cache.put(cacheKey, cacheResp))
  }

  return resp
}

async function handleCategories(request, env, ctx) {
  const supabaseUrl = `${env.SUPABASE_URL}/rest/v1/skill_categories?select=*&order=sort_order`
  // Cache key must be same zone — use worker's own URL
  const cacheKey = new Request(request.url, { method: 'GET' })

  const cache = caches.default
  let response = await cache.match(cacheKey)
  if (response) {
    const headers = new Headers(response.headers)
    headers.set('x-cache', 'HIT')
    Object.entries(CORS_HEADERS).forEach(([k, v]) => headers.set(k, v))
    return new Response(response.body, { status: response.status, headers })
  }

  // Fetch categories
  const catResp = await fetch(supabaseUrl, {
    headers: {
      'apikey': env.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
      'Accept': 'application/json',
    },
  })
  const cats = await catResp.json()
  if (!catResp.ok) return json(cats, catResp.status)

  // Count per category in parallel
  const countPromises = cats.map(cat =>
    fetch(`${env.SUPABASE_URL}/rest/v1/skill_catalog?select=id&category_id=eq.${cat.id}`, {
      method: 'HEAD',
      headers: {
        'apikey': env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
        'Prefer': 'count=exact',
      },
    }).then(r => {
      const range = r.headers.get('content-range') || ''
      const total = parseInt(range.split('/')[1]) || 0
      return { slug: cat.slug, count: total }
    })
  )
  const counts = await Promise.all(countPromises)
  const countMap = {}
  for (const { slug, count } of counts) countMap[slug] = count

  const body = JSON.stringify({ categories: cats, counts: countMap })
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': `public, max-age=${CACHE_TTL}, stale-while-revalidate=${STALE_TTL}`,
    'x-cache': 'MISS',
    ...CORS_HEADERS,
  }

  const resp = new Response(body, { status: 200, headers })

  // Cache it
  const cacheResp = new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_TTL}` },
  })
  ctx.waitUntil(cache.put(cacheKey, cacheResp))

  return resp
}

async function handlePurge(request, env, url) {
  const token = url.searchParams.get('token') || request.headers.get('x-purge-token')
  if (!env.PURGE_SECRET || token !== env.PURGE_SECRET) {
    return json({ error: 'Unauthorized' }, 401)
  }

  // Purge by deleting known cache keys
  // For broad purge, use Cloudflare API
  if (env.CF_API_TOKEN && env.CF_ZONE_ID) {
    const resp = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/purge_cache`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.CF_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ purge_everything: true }),
      }
    )
    const data = await resp.json()
    return json({ message: data.success ? 'Cache purged' : 'Purge failed', details: data })
  }

  return json({ message: 'No CF_API_TOKEN configured, cache will expire naturally' })
}

// --- Helpers ---

function extractPrefer(params) {
  // Detect if client wants count
  const select = params.get('select') || ''
  if (params.has('offset') || params.has('limit')) {
    return 'count=exact'
  }
  return ''
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}
