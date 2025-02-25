import type {
  WorkAsyncStorage,
  WorkStore,
} from '../../client/components/work-async-storage.external'

import { AppRenderSpan, NextNodeServerSpan } from './trace/constants'
import { getTracer, SpanKind } from './trace/tracer'
import {
  CACHE_ONE_YEAR,
  NEXT_CACHE_IMPLICIT_TAG_ID,
  NEXT_CACHE_TAG_MAX_ITEMS,
  NEXT_CACHE_TAG_MAX_LENGTH,
} from '../../lib/constants'
import { markCurrentScopeAsDynamic } from '../app-render/dynamic-rendering'
import type { FetchMetric } from '../base-http'
import { createDedupeFetch } from './dedupe-fetch'
import type {
  WorkUnitAsyncStorage,
  WorkUnitStore,
  RequestStore,
} from '../../server/app-render/work-unit-async-storage.external'
import {
  CachedRouteKind,
  IncrementalCacheKind,
  type CachedFetchData,
} from '../response-cache'
import { waitAtLeastOneReactRenderTask } from '../../lib/scheduler'

const isEdgeRuntime = process.env.NEXT_RUNTIME === 'edge'

type Fetcher = typeof fetch

type PatchedFetcher = Fetcher & {
  readonly __nextPatched: true
  readonly __nextGetStaticStore: () => WorkAsyncStorage
  readonly _nextOriginalFetch: Fetcher
}

export const NEXT_PATCH_SYMBOL = Symbol.for('next-patch')

function isFetchPatched() {
  return (globalThis as Record<symbol, unknown>)[NEXT_PATCH_SYMBOL] === true
}

export function validateRevalidate(
  revalidateVal: unknown,
  route: string
): undefined | number | false {
  try {
    let normalizedRevalidate: false | number | undefined = undefined

    if (revalidateVal === false) {
      normalizedRevalidate = revalidateVal
    } else if (
      typeof revalidateVal === 'number' &&
      !isNaN(revalidateVal) &&
      revalidateVal > -1
    ) {
      normalizedRevalidate = revalidateVal
    } else if (typeof revalidateVal !== 'undefined') {
      throw new Error(
        `Invalid revalidate value "${revalidateVal}" on "${route}", must be a non-negative number or false`
      )
    }
    return normalizedRevalidate
  } catch (err: any) {
    // handle client component error from attempting to check revalidate value
    if (err instanceof Error && err.message.includes('Invalid revalidate')) {
      throw err
    }
    return undefined
  }
}

export function validateTags(tags: any[], description: string) {
  const validTags: string[] = []
  const invalidTags: Array<{
    tag: any
    reason: string
  }> = []

  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i]

    if (typeof tag !== 'string') {
      invalidTags.push({ tag, reason: 'invalid type, must be a string' })
    } else if (tag.length > NEXT_CACHE_TAG_MAX_LENGTH) {
      invalidTags.push({
        tag,
        reason: `exceeded max length of ${NEXT_CACHE_TAG_MAX_LENGTH}`,
      })
    } else {
      validTags.push(tag)
    }

    if (validTags.length > NEXT_CACHE_TAG_MAX_ITEMS) {
      console.warn(
        `Warning: exceeded max tag count for ${description}, dropped tags:`,
        tags.slice(i).join(', ')
      )
      break
    }
  }

  if (invalidTags.length > 0) {
    console.warn(`Warning: invalid tags passed to ${description}: `)

    for (const { tag, reason } of invalidTags) {
      console.log(`tag: "${tag}" ${reason}`)
    }
  }
  return validTags
}

const getDerivedTags = (pathname: string): string[] => {
  const derivedTags: string[] = [`/layout`]

  // we automatically add the current path segments as tags
  // for revalidatePath handling
  if (pathname.startsWith('/')) {
    const pathnameParts = pathname.split('/')

    for (let i = 1; i < pathnameParts.length + 1; i++) {
      let curPathname = pathnameParts.slice(0, i).join('/')

      if (curPathname) {
        // all derived tags other than the page are layout tags
        if (!curPathname.endsWith('/page') && !curPathname.endsWith('/route')) {
          curPathname = `${curPathname}${
            !curPathname.endsWith('/') ? '/' : ''
          }layout`
        }
        derivedTags.push(curPathname)
      }
    }
  }
  return derivedTags
}

export function addImplicitTags(
  workStore: WorkStore,
  workUnitStore: WorkUnitStore | undefined
) {
  const newTags: string[] = []
  const { page, fallbackRouteParams } = workStore
  const hasFallbackRouteParams =
    fallbackRouteParams && fallbackRouteParams.size > 0

  // Ini the tags array if it doesn't exist.
  if (
    !workUnitStore ||
    (workUnitStore.type !== 'cache' && workUnitStore.type !== 'unstable-cache')
  ) {
    workStore.tags ??= []
  }

  // Add the derived tags from the page.
  const derivedTags = getDerivedTags(page)
  for (let tag of derivedTags) {
    tag = `${NEXT_CACHE_IMPLICIT_TAG_ID}${tag}`
    if (
      !workUnitStore ||
      (workUnitStore.type !== 'cache' &&
        workUnitStore.type !== 'unstable-cache')
    ) {
      if (!workStore.tags?.includes(tag)) {
        workStore.tags?.push(tag)
      }
    }
    newTags.push(tag)
  }

  const renderedPathname =
    workUnitStore !== undefined
      ? workUnitStore.type === 'request'
        ? workUnitStore.url.pathname
        : workUnitStore.type === 'prerender' ||
            workUnitStore.type === 'prerender-legacy'
          ? workUnitStore.pathname
          : undefined
      : undefined

  // Add the tags from the pathname. If the route has unknown params, we don't
  // want to add the pathname as a tag, as it will be invalid.
  if (renderedPathname && !hasFallbackRouteParams) {
    const tag = `${NEXT_CACHE_IMPLICIT_TAG_ID}${renderedPathname}`
    if (!workStore.tags?.includes(tag)) {
      workStore.tags?.push(tag)
    }
    newTags.push(tag)
  }

  return newTags
}

function trackFetchMetric(
  workStore: WorkStore,
  ctx: Omit<FetchMetric, 'end' | 'idx'>
) {
  // If the static generation store is not available, we can't track the fetch
  if (!workStore) return
  if (workStore.requestEndedState?.ended) return

  const isDebugBuild =
    (!!process.env.NEXT_DEBUG_BUILD ||
      process.env.NEXT_SSG_FETCH_METRICS === '1') &&
    workStore.isStaticGeneration
  const isDevelopment = process.env.NODE_ENV === 'development'

  if (
    // The only time we want to track fetch metrics outside of development is when
    // we are performing a static generation & we are in debug mode.
    !isDebugBuild &&
    !isDevelopment
  ) {
    return
  }

  workStore.fetchMetrics ??= []

  workStore.fetchMetrics.push({
    ...ctx,
    end: performance.timeOrigin + performance.now(),
    idx: workStore.nextFetchId || 0,
  })
}

interface PatchableModule {
  workAsyncStorage: WorkAsyncStorage
  workUnitAsyncStorage: WorkUnitAsyncStorage
}

export function createPatchedFetcher(
  originFetch: Fetcher,
  { workAsyncStorage, workUnitAsyncStorage }: PatchableModule
): PatchedFetcher {
  // Create the patched fetch function. We don't set the type here, as it's
  // verified as the return value of this function.
  const patched = async (
    input: RequestInfo | URL,
    init: RequestInit | undefined
  ) => {
    let url: URL | undefined
    try {
      url = new URL(input instanceof Request ? input.url : input)
      url.username = ''
      url.password = ''
    } catch {
      // Error caused by malformed URL should be handled by native fetch
      url = undefined
    }
    const fetchUrl = url?.href ?? ''
    const fetchStart = performance.timeOrigin + performance.now()
    const method = init?.method?.toUpperCase() || 'GET'

    // Do create a new span trace for internal fetches in the
    // non-verbose mode.
    const isInternal = (init?.next as any)?.internal === true
    const hideSpan = process.env.NEXT_OTEL_FETCH_DISABLED === '1'

    const workStore = workAsyncStorage.getStore()
    const workUnitStore = workUnitAsyncStorage.getStore()

    const result = getTracer().trace(
      isInternal ? NextNodeServerSpan.internalFetch : AppRenderSpan.fetch,
      {
        hideSpan,
        kind: SpanKind.CLIENT,
        spanName: ['fetch', method, fetchUrl].filter(Boolean).join(' '),
        attributes: {
          'http.url': fetchUrl,
          'http.method': method,
          'net.peer.name': url?.hostname,
          'net.peer.port': url?.port || undefined,
        },
      },
      async () => {
        // If this is an internal fetch, we should not do any special treatment.
        if (isInternal) {
          return originFetch(input, init)
        }

        // If the workStore is not available, we can't do any
        // special treatment of fetch, therefore fallback to the original
        // fetch implementation.
        if (!workStore) {
          return originFetch(input, init)
        }

        // We should also fallback to the original fetch implementation if we
        // are in draft mode, it does not constitute a static generation.
        if (workStore.isDraftMode) {
          return originFetch(input, init)
        }

        const isRequestInput =
          input &&
          typeof input === 'object' &&
          typeof (input as Request).method === 'string'

        const getRequestMeta = (field: string) => {
          // If request input is present but init is not, retrieve from input first.
          const value = (init as any)?.[field]
          return value || (isRequestInput ? (input as any)[field] : null)
        }

        let finalRevalidate: number | undefined | false = undefined
        const getNextField = (field: 'revalidate' | 'tags') => {
          return typeof init?.next?.[field] !== 'undefined'
            ? init?.next?.[field]
            : isRequestInput
              ? (input as any).next?.[field]
              : undefined
        }
        // RequestInit doesn't keep extra fields e.g. next so it's
        // only available if init is used separate
        let currentFetchRevalidate = getNextField('revalidate')
        const tags: string[] = validateTags(
          getNextField('tags') || [],
          `fetch ${input.toString()}`
        )

        if (
          !workUnitStore ||
          (workUnitStore.type !== 'cache' &&
            workUnitStore.type !== 'unstable-cache')
        ) {
          if (Array.isArray(tags)) {
            if (!workStore.tags) {
              workStore.tags = []
            }
            for (const tag of tags) {
              if (!workStore.tags.includes(tag)) {
                workStore.tags.push(tag)
              }
            }
          }
        }

        const implicitTags = addImplicitTags(workStore, workUnitStore)

        // Inside unstable-cache we treat it the same as force-no-store on the page.
        const pageFetchCacheMode =
          workUnitStore && workUnitStore.type === 'unstable-cache'
            ? 'force-no-store'
            : workStore.fetchCache
        const isUsingNoStore = !!workStore.isUnstableNoStore

        let currentFetchCacheConfig = getRequestMeta('cache')
        let cacheReason = ''
        let cacheWarning: string | undefined

        if (
          typeof currentFetchCacheConfig === 'string' &&
          typeof currentFetchRevalidate !== 'undefined'
        ) {
          // when providing fetch with a Request input, it'll automatically set a cache value of 'default'
          // we only want to warn if the user is explicitly setting a cache value
          if (!(isRequestInput && currentFetchCacheConfig === 'default')) {
            cacheWarning = `Specified "cache: ${currentFetchCacheConfig}" and "revalidate: ${currentFetchRevalidate}", only one should be specified.`
          }
          currentFetchCacheConfig = undefined
        }

        if (currentFetchCacheConfig === 'force-cache') {
          currentFetchRevalidate = false
        } else if (
          currentFetchCacheConfig === 'no-cache' ||
          currentFetchCacheConfig === 'no-store' ||
          pageFetchCacheMode === 'force-no-store' ||
          pageFetchCacheMode === 'only-no-store' ||
          // If no explicit fetch cache mode is set, but dynamic = `force-dynamic` is set,
          // we shouldn't consider caching the fetch. This is because the `dynamic` cache
          // is considered a "top-level" cache mode, whereas something like `fetchCache` is more
          // fine-grained. Top-level modes are responsible for setting reasonable defaults for the
          // other configurations.
          (!pageFetchCacheMode && workStore.forceDynamic)
        ) {
          currentFetchRevalidate = 0
        }

        if (
          currentFetchCacheConfig === 'no-cache' ||
          currentFetchCacheConfig === 'no-store'
        ) {
          cacheReason = `cache: ${currentFetchCacheConfig}`
        }

        finalRevalidate = validateRevalidate(
          currentFetchRevalidate,
          workStore.route
        )

        const _headers = getRequestMeta('headers')
        const initHeaders: Headers =
          typeof _headers?.get === 'function'
            ? _headers
            : new Headers(_headers || {})

        const hasUnCacheableHeader =
          initHeaders.get('authorization') || initHeaders.get('cookie')

        const isUnCacheableMethod = !['get', 'head'].includes(
          getRequestMeta('method')?.toLowerCase() || 'get'
        )

        /**
         * We automatically disable fetch caching under the following conditions:
         * - Fetch cache configs are not set. Specifically:
         *    - A page fetch cache mode is not set (export const fetchCache=...)
         *    - A fetch cache mode is not set in the fetch call (fetch(url, { cache: ... }))
         *    - A fetch revalidate value is not set in the fetch call (fetch(url, { revalidate: ... }))
         * - OR the fetch comes after a configuration that triggered dynamic rendering (e.g., reading cookies())
         *   and the fetch was considered uncacheable (e.g., POST method or has authorization headers)
         */
        const hasNoExplicitCacheConfig =
          // eslint-disable-next-line eqeqeq
          pageFetchCacheMode == undefined &&
          // eslint-disable-next-line eqeqeq
          currentFetchCacheConfig == undefined &&
          // eslint-disable-next-line eqeqeq
          currentFetchRevalidate == undefined
        const autoNoCache =
          // this condition is hit for null/undefined
          // eslint-disable-next-line eqeqeq
          (hasNoExplicitCacheConfig &&
            // we disable automatic no caching behavior during build time SSG so that we can still
            // leverage the fetch cache between SSG workers
            !workStore.isPrerendering) ||
          ((hasUnCacheableHeader || isUnCacheableMethod) &&
            workStore.revalidate === 0)

        switch (pageFetchCacheMode) {
          case 'force-no-store': {
            cacheReason = 'fetchCache = force-no-store'
            break
          }
          case 'only-no-store': {
            if (
              currentFetchCacheConfig === 'force-cache' ||
              (typeof finalRevalidate !== 'undefined' &&
                (finalRevalidate === false || finalRevalidate > 0))
            ) {
              throw new Error(
                `cache: 'force-cache' used on fetch for ${fetchUrl} with 'export const fetchCache = 'only-no-store'`
              )
            }
            cacheReason = 'fetchCache = only-no-store'
            break
          }
          case 'only-cache': {
            if (currentFetchCacheConfig === 'no-store') {
              throw new Error(
                `cache: 'no-store' used on fetch for ${fetchUrl} with 'export const fetchCache = 'only-cache'`
              )
            }
            break
          }
          case 'force-cache': {
            if (
              typeof currentFetchRevalidate === 'undefined' ||
              currentFetchRevalidate === 0
            ) {
              cacheReason = 'fetchCache = force-cache'
              finalRevalidate = false
            }
            break
          }
          default:
          // sometimes we won't match the above cases. the reason we don't move
          // everything to this switch is the use of autoNoCache which is not a fetchCacheMode
          // I suspect this could be unified with fetchCacheMode however in which case we could
          // simplify the switch case and ensure we have an exhaustive switch handling all modes
        }

        if (typeof finalRevalidate === 'undefined') {
          if (pageFetchCacheMode === 'default-cache' && !isUsingNoStore) {
            finalRevalidate = false
            cacheReason = 'fetchCache = default-cache'
          } else if (pageFetchCacheMode === 'default-no-store') {
            finalRevalidate = 0
            cacheReason = 'fetchCache = default-no-store'
          } else if (isUsingNoStore) {
            finalRevalidate = 0
            cacheReason = 'noStore call'
          } else if (autoNoCache) {
            finalRevalidate = 0
            cacheReason = 'auto no cache'
          } else {
            // TODO: should we consider this case an invariant?
            cacheReason = 'auto cache'
            finalRevalidate =
              typeof workStore.revalidate === 'boolean' ||
              typeof workStore.revalidate === 'undefined'
                ? false
                : workStore.revalidate
          }
        } else if (!cacheReason) {
          cacheReason = `revalidate: ${finalRevalidate}`
        }

        if (
          // when force static is configured we don't bail from
          // `revalidate: 0` values
          !(workStore.forceStatic && finalRevalidate === 0) &&
          // we don't consider autoNoCache to switch to dynamic for ISR
          !autoNoCache &&
          // If the revalidate value isn't currently set or the value is less
          // than the current revalidate value, we should update the revalidate
          // value.
          (typeof workStore.revalidate === 'undefined' ||
            (typeof finalRevalidate === 'number' &&
              (workStore.revalidate === false ||
                (typeof workStore.revalidate === 'number' &&
                  finalRevalidate < workStore.revalidate))))
        ) {
          if (
            !workUnitStore ||
            (workUnitStore.type !== 'cache' &&
              workUnitStore.type !== 'unstable-cache')
          ) {
            // If we were setting the revalidate value to 0, we should try to
            // postpone instead first.
            if (finalRevalidate === 0) {
              markCurrentScopeAsDynamic(
                workStore,
                workUnitStore,
                `revalidate: 0 fetch ${input} ${workStore.route}`
              )
            }

            workStore.revalidate = finalRevalidate
          }
        }

        const isCacheableRevalidate =
          (typeof finalRevalidate === 'number' && finalRevalidate > 0) ||
          finalRevalidate === false

        let cacheKey: string | undefined
        const { incrementalCache } = workStore

        const requestStore: undefined | RequestStore =
          workUnitStore !== undefined && workUnitStore.type === 'request'
            ? workUnitStore
            : undefined

        if (
          incrementalCache &&
          (isCacheableRevalidate || requestStore?.serverComponentsHmrCache)
        ) {
          try {
            cacheKey = await incrementalCache.generateCacheKey(
              fetchUrl,
              isRequestInput ? (input as RequestInit) : init
            )
          } catch (err) {
            console.error(`Failed to generate cache key for`, input)
          }
        }

        const fetchIdx = workStore.nextFetchId ?? 1
        workStore.nextFetchId = fetchIdx + 1

        const normalizedRevalidate =
          typeof finalRevalidate !== 'number' ? CACHE_ONE_YEAR : finalRevalidate

        let handleUnlock = () => Promise.resolve()

        const doOriginalFetch = async (
          isStale?: boolean,
          cacheReasonOverride?: string
        ) => {
          const requestInputFields = [
            'cache',
            'credentials',
            'headers',
            'integrity',
            'keepalive',
            'method',
            'mode',
            'redirect',
            'referrer',
            'referrerPolicy',
            'window',
            'duplex',

            // don't pass through signal when revalidating
            ...(isStale ? [] : ['signal']),
          ]

          if (isRequestInput) {
            const reqInput: Request = input as any
            const reqOptions: RequestInit = {
              body: (reqInput as any)._ogBody || reqInput.body,
            }

            for (const field of requestInputFields) {
              // @ts-expect-error custom fields
              reqOptions[field] = reqInput[field]
            }
            input = new Request(reqInput.url, reqOptions)
          } else if (init) {
            const { _ogBody, body, signal, ...otherInput } =
              init as RequestInit & { _ogBody?: any }
            init = {
              ...otherInput,
              body: _ogBody || body,
              signal: isStale ? undefined : signal,
            }
          }

          // add metadata to init without editing the original
          const clonedInit = {
            ...init,
            next: { ...init?.next, fetchType: 'origin', fetchIdx },
          }

          return originFetch(input, clonedInit).then(async (res) => {
            if (!isStale) {
              trackFetchMetric(workStore, {
                start: fetchStart,
                url: fetchUrl,
                cacheReason: cacheReasonOverride || cacheReason,
                cacheStatus:
                  finalRevalidate === 0 || cacheReasonOverride
                    ? 'skip'
                    : 'miss',
                cacheWarning,
                status: res.status,
                method: clonedInit.method || 'GET',
              })
            }
            if (
              res.status === 200 &&
              incrementalCache &&
              cacheKey &&
              (isCacheableRevalidate || requestStore?.serverComponentsHmrCache)
            ) {
              if (workUnitStore && workUnitStore.type === 'prerender') {
                // We are prerendering at build time or revalidate time so we need to
                // buffer the response so we can guarantee it can be read in a microtask

                const bodyBuffer = await res.arrayBuffer()

                const fetchedData = {
                  headers: Object.fromEntries(res.headers.entries()),
                  body: Buffer.from(bodyBuffer).toString('base64'),
                  status: res.status,
                  url: res.url,
                }

                // We can skip checking the serverComponentsHmrCache because we aren't in
                // dev mode.

                await incrementalCache.set(
                  cacheKey,
                  {
                    kind: CachedRouteKind.FETCH,
                    data: fetchedData,
                    revalidate: normalizedRevalidate,
                  },
                  {
                    fetchCache: true,
                    revalidate: finalRevalidate,
                    fetchUrl,
                    fetchIdx,
                    tags,
                  }
                )
                await handleUnlock()

                // We we return a new Response to the caller.
                return new Response(bodyBuffer, {
                  headers: res.headers,
                  status: res.status,
                  statusText: res.statusText,
                })
              } else {
                // We are dynamically rendering including dev mode. We want to return
                // the response to the caller as soon  as possible because it might stream
                // over a very long time.
                res
                  .clone()
                  .arrayBuffer()
                  .then(async (arrayBuffer) => {
                    const bodyBuffer = Buffer.from(arrayBuffer)

                    const fetchedData = {
                      headers: Object.fromEntries(res.headers.entries()),
                      body: bodyBuffer.toString('base64'),
                      status: res.status,
                      url: res.url,
                    }

                    requestStore?.serverComponentsHmrCache?.set(
                      cacheKey,
                      fetchedData
                    )

                    if (isCacheableRevalidate) {
                      await incrementalCache.set(
                        cacheKey,
                        {
                          kind: CachedRouteKind.FETCH,
                          data: fetchedData,
                          revalidate: normalizedRevalidate,
                        },
                        {
                          fetchCache: true,
                          revalidate: finalRevalidate,
                          fetchUrl,
                          fetchIdx,
                          tags,
                        }
                      )
                    }
                  })
                  .catch((error) =>
                    console.warn(`Failed to set fetch cache`, input, error)
                  )
                  .finally(handleUnlock)

                return res
              }
            }

            // we had response that we determined shouldn't be cached so we return it
            // and don't cache it. This also needs to unlock the cache lock we acquired.
            await handleUnlock()

            return res
          })
        }

        let cacheReasonOverride
        let isForegroundRevalidate = false
        let isHmrRefreshCache = false

        if (cacheKey && incrementalCache) {
          let cachedFetchData: CachedFetchData | undefined

          if (
            requestStore?.isHmrRefresh &&
            requestStore.serverComponentsHmrCache
          ) {
            cachedFetchData =
              requestStore.serverComponentsHmrCache.get(cacheKey)

            isHmrRefreshCache = true
          }

          if (isCacheableRevalidate && !cachedFetchData) {
            handleUnlock = await incrementalCache.lock(cacheKey)
            const entry = workStore.isOnDemandRevalidate
              ? null
              : await incrementalCache.get(cacheKey, {
                  kind: IncrementalCacheKind.FETCH,
                  revalidate: finalRevalidate,
                  fetchUrl,
                  fetchIdx,
                  tags,
                  softTags: implicitTags,
                  isFallback: false,
                })

            if (hasNoExplicitCacheConfig) {
              // We sometimes use the cache to dedupe fetches that do not specify a cache configuration
              // In these cases we want to make sure we still exclude them from prerenders if dynamicIO is on
              // so we introduce an artificial Task boundary here.
              if (workUnitStore && workUnitStore.type === 'prerender') {
                await waitAtLeastOneReactRenderTask()
              }
            }

            if (entry) {
              await handleUnlock()
            } else {
              // in dev, incremental cache response will be null in case the browser adds `cache-control: no-cache` in the request headers
              cacheReasonOverride = 'cache-control: no-cache (hard refresh)'
            }

            if (entry?.value && entry.value.kind === CachedRouteKind.FETCH) {
              // when stale and is revalidating we wait for fresh data
              // so the revalidated entry has the updated data
              if (workStore.isRevalidate && entry.isStale) {
                isForegroundRevalidate = true
              } else {
                if (entry.isStale) {
                  workStore.pendingRevalidates ??= {}
                  if (!workStore.pendingRevalidates[cacheKey]) {
                    workStore.pendingRevalidates[cacheKey] = doOriginalFetch(
                      true
                    )
                      .catch(console.error)
                      .finally(() => {
                        workStore.pendingRevalidates ??= {}
                        delete workStore.pendingRevalidates[cacheKey || '']
                      })
                  }
                }

                cachedFetchData = entry.value.data
              }
            }
          }

          if (cachedFetchData) {
            trackFetchMetric(workStore, {
              start: fetchStart,
              url: fetchUrl,
              cacheReason,
              cacheStatus: isHmrRefreshCache ? 'hmr' : 'hit',
              cacheWarning,
              status: cachedFetchData.status || 200,
              method: init?.method || 'GET',
            })

            const response = new Response(
              Buffer.from(cachedFetchData.body, 'base64'),
              {
                headers: cachedFetchData.headers,
                status: cachedFetchData.status,
              }
            )

            Object.defineProperty(response, 'url', {
              value: cachedFetchData.url,
            })

            return response
          }
        }

        if (workStore.isStaticGeneration && init && typeof init === 'object') {
          const { cache } = init

          // Delete `cache` property as Cloudflare Workers will throw an error
          if (isEdgeRuntime) delete init.cache

          if (cache === 'no-store') {
            // If enabled, we should bail out of static generation.
            markCurrentScopeAsDynamic(
              workStore,
              workUnitStore,
              `no-store fetch ${input} ${workStore.route}`
            )
          }

          const hasNextConfig = 'next' in init
          const { next = {} } = init
          if (
            typeof next.revalidate === 'number' &&
            (typeof workStore.revalidate === 'undefined' ||
              (typeof workStore.revalidate === 'number' &&
                next.revalidate < workStore.revalidate))
          ) {
            if (next.revalidate === 0) {
              // If enabled, we should bail out of static generation.
              markCurrentScopeAsDynamic(
                workStore,
                workUnitStore,
                `revalidate: 0 fetch ${input} ${workStore.route}`
              )
            }

            if (!workStore.forceStatic || next.revalidate !== 0) {
              if (
                !workUnitStore ||
                (workUnitStore.type !== 'cache' &&
                  workUnitStore.type !== 'unstable-cache')
              ) {
                workStore.revalidate = next.revalidate
              }
            }
          }
          if (hasNextConfig) delete init.next
        }

        // if we are revalidating the whole page via time or on-demand and
        // the fetch cache entry is stale we should still de-dupe the
        // origin hit if it's a cache-able entry
        if (cacheKey && isForegroundRevalidate) {
          const pendingRevalidateKey = cacheKey
          workStore.pendingRevalidates ??= {}
          const pendingRevalidate =
            workStore.pendingRevalidates[pendingRevalidateKey]

          if (pendingRevalidate) {
            const revalidatedResult: {
              body: ArrayBuffer
              headers: Headers
              status: number
              statusText: string
            } = await pendingRevalidate
            return new Response(revalidatedResult.body, {
              headers: revalidatedResult.headers,
              status: revalidatedResult.status,
              statusText: revalidatedResult.statusText,
            })
          }

          // We used to just resolve the Response and clone it however for
          // static generation with dynamicIO we need the response to be able to
          // be resolved in a microtask and Response#clone() will never have a
          // body that can resolve in a microtask in node (as observed through
          // experimentation) So instead we await the body and then when it is
          // available we construct manually cloned Response objects with the
          // body as an ArrayBuffer. This will be resolvable in a microtask
          // making it compatible with dynamicIO.
          const pendingResponse = doOriginalFetch(true, cacheReasonOverride)

          const nextRevalidate = pendingResponse
            .then(async (response) => {
              // Clone the response here. It'll run first because we attached
              // the resolve before we returned below. We have to clone it
              // because the original response is going to be consumed by
              // at a later point in time.
              const clonedResponse = response.clone()

              return {
                body: await clonedResponse.arrayBuffer(),
                headers: clonedResponse.headers,
                status: clonedResponse.status,
                statusText: clonedResponse.statusText,
              }
            })
            .finally(() => {
              // If the pending revalidate is not present in the store, then
              // we have nothing to delete.
              if (!workStore.pendingRevalidates?.[pendingRevalidateKey]) {
                return
              }

              delete workStore.pendingRevalidates[pendingRevalidateKey]
            })

          // Attach the empty catch here so we don't get a "unhandled promise
          // rejection" warning
          nextRevalidate.catch(() => {})

          workStore.pendingRevalidates[pendingRevalidateKey] = nextRevalidate

          return pendingResponse
        } else {
          return doOriginalFetch(false, cacheReasonOverride)
        }
      }
    )

    if (
      workUnitStore &&
      workUnitStore.type === 'prerender' &&
      workUnitStore.cacheSignal
    ) {
      // During static generation we track cache reads so we can reason about when they fill
      const cacheSignal = workUnitStore.cacheSignal
      cacheSignal.beginRead()
      try {
        return await result
      } finally {
        cacheSignal.endRead()
      }
    } else {
      return result
    }
  }

  // Attach the necessary properties to the patched fetch function.
  // We don't use this to determine if the fetch function has been patched,
  // but for external consumers to determine if the fetch function has been
  // patched.
  patched.__nextPatched = true as const
  patched.__nextGetStaticStore = () => workAsyncStorage
  patched._nextOriginalFetch = originFetch
  ;(globalThis as Record<symbol, unknown>)[NEXT_PATCH_SYMBOL] = true

  return patched
}
// we patch fetch to collect cache information used for
// determining if a page is static or not
export function patchFetch(options: PatchableModule) {
  // If we've already patched fetch, we should not patch it again.
  if (isFetchPatched()) return

  // Grab the original fetch function. We'll attach this so we can use it in
  // the patched fetch function.
  const original = createDedupeFetch(globalThis.fetch)

  // Set the global fetch to the patched fetch.
  globalThis.fetch = createPatchedFetcher(original, options)
}
