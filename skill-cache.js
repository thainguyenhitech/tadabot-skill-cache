/**
 * Cloudflare Worker: Skill Catalog Cache Proxy
 *
 * Cache Supabase skill_catalog queries 1 ngày tại edge.
 * Purge instant bằng cache version trong KV.
 *
 * Endpoints:
 *   GET  /skills?{supabase query params}  → cached response
 *   GET  /categories                       → cached categories + counts
 *   POST /purge?token=<SECRET>             → bump version, cache mới ngay
 *   GET  /health                            → health check
 *
 * Setup KV (1 lần):
 *   Cloudflare Dashboard → Workers & Pages → KV → Create namespace: "tadabot-cache-meta"
 *   Workers → tadabot-skill-cache → Settings → Bindings → KV → CACHE_META = tadabot-cache-meta
 *
 * Deploy: cd workers && npx wrangler deploy -c wrangler-skill-cache.toml
 */

const CACHE_TTL = 86400 // 1 ngày
const STALE_TTL = 172800
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Expose-Headers': 'content-range',
}

async function getCacheVersion(env) {
  if (!env.CACHE_META) return '0'
  return (await env.CACHE_META.get('v')) || '0'
}

function makeCacheKey(urlStr, version) {
  const u = new URL(urlStr)
  u.searchParams.set('_v', version)
  return new Request(u.toString(), { method: 'GET' })
}

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS })
      }

      const url = new URL(request.url)
      const path = url.pathname

      if (path === '/health') {
        const v = await getCacheVersion(env)
        return json({ ok: true, cache_version: v, kv_bound: !!env.CACHE_META })
      }

      if (path === '/purge' && request.method === 'POST') {
        return handlePurge(request, env)
      }

      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405)

      const version = await getCacheVersion(env)

      if (path === '/categories') return handleCategories(request, env, ctx, version)
      if (path === '/skills') return handleSkills(request, env, url, ctx, version)

      return json({ error: 'Not found' }, 404)
    } catch (e) {
      return json({ error: e.message }, 500)
    }
  },
}

// --- Handlers ---

async function handleSkills(request, env, url, ctx, version) {
  const supabaseUrl = `${env.SUPABASE_URL}/rest/v1/skill_catalog?${url.searchParams.toString()}`
  const cacheKey = makeCacheKey(url.toString(), version)
  const cache = caches.default

  const cached = await cache.match(cacheKey)
  if (cached) {
    const h = new Headers(cached.headers)
    h.set('x-cache', 'HIT')
    h.set('x-cache-version', version)
    Object.entries(CORS_HEADERS).forEach(([k, v]) => h.set(k, v))
    return new Response(cached.body, { status: cached.status, headers: h })
  }

  const resp = await fetch(supabaseUrl, {
    headers: {
      'apikey': env.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
      'Accept': 'application/json',
      'Prefer': extractPrefer(url.searchParams),
    },
  })

  const body = await resp.text()
  const contentRange = resp.headers.get('content-range')
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': `public, no-cache, s-maxage=${CACHE_TTL}, stale-while-revalidate=${STALE_TTL}`,
    'x-cache': 'MISS',
    'x-cache-version': version,
    ...CORS_HEADERS,
  }
  if (contentRange) headers['content-range'] = contentRange

  if (resp.ok) {
    const cacheHeaders = { 'Content-Type': 'application/json', 'Cache-Control': `public, s-maxage=${CACHE_TTL}` }
    if (contentRange) cacheHeaders['content-range'] = contentRange
    ctx.waitUntil(cache.put(cacheKey, new Response(body, { status: resp.status, headers: cacheHeaders })))
  }

  return new Response(body, { status: resp.status, headers })
}

async function handleCategories(request, env, ctx, version) {
  const cacheKey = makeCacheKey(request.url, version)
  const cache = caches.default

  const cached = await cache.match(cacheKey)
  if (cached) {
    const h = new Headers(cached.headers)
    h.set('x-cache', 'HIT')
    h.set('x-cache-version', version)
    Object.entries(CORS_HEADERS).forEach(([k, v]) => h.set(k, v))
    return new Response(cached.body, { status: cached.status, headers: h })
  }

  const catResp = await fetch(`${env.SUPABASE_URL}/rest/v1/skill_categories?select=*&order=sort_order`, {
    headers: {
      'apikey': env.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
      'Accept': 'application/json',
    },
  })
  const cats = await catResp.json()
  if (!catResp.ok) return json(cats, catResp.status)

  const counts = await Promise.all(cats.map(cat =>
    fetch(`${env.SUPABASE_URL}/rest/v1/skill_catalog?select=id&category_id=eq.${cat.id}`, {
      method: 'HEAD',
      headers: {
        'apikey': env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
        'Prefer': 'count=exact',
      },
    }).then(r => {
      const range = r.headers.get('content-range') || ''
      return { slug: cat.slug, count: parseInt(range.split('/')[1]) || 0 }
    })
  ))

  const countMap = Object.fromEntries(counts.map(c => [c.slug, c.count]))
  const result = cats.map(cat => ({ ...cat, skill_count: countMap[cat.slug] || 0 }))
  const body = JSON.stringify(result)

  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': `public, no-cache, s-maxage=${CACHE_TTL}, stale-while-revalidate=${STALE_TTL}`,
    'x-cache': 'MISS',
    'x-cache-version': version,
    ...CORS_HEADERS,
  }

  ctx.waitUntil(cache.put(cacheKey, new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, s-maxage=${CACHE_TTL}` },
  })))

  return new Response(body, { status: 200, headers })
}

async function handlePurge(request, env) {
  const url = new URL(request.url)
  const token = url.searchParams.get('token') || request.headers.get('x-purge-token')
  if (!env.PURGE_SECRET || token !== env.PURGE_SECRET) {
    return json({ error: 'Unauthorized' }, 401)
  }

  if (!env.CACHE_META) {
    return json({ error: 'KV binding CACHE_META chưa cấu hình. Vào Cloudflare Dashboard → Workers → Settings → Bindings → thêm KV CACHE_META' }, 500)
  }

  const old = (await env.CACHE_META.get('v')) || '0'
  const next = String(parseInt(old) + 1)
  await env.CACHE_META.put('v', next)

  return json({ message: 'Cache purged', old_version: old, new_version: next })
}

// --- Helpers ---

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

function extractPrefer(params) {
  const parts = []
  if (params.has('count')) parts.push(`count=${params.get('count')}`)
  const prefer = params.get('prefer')
  if (prefer) parts.push(prefer)
  return parts.join(', ') || 'return=representation'
}
