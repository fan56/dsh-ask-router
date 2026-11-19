/**
 * dsh-ask-router — interaction routing for ask-user questions.
 *
 * Answerers compose on the scoped 'user-questions/request' cordis waterfall,
 * where a listener answers by returning a value and delegates by calling
 * `next()`. This plugin registers as one waterfall answerer.
 *
 * The plugin provides `ctx.askSurfaces`, a registry where UIs register as
 * surfaces with a `claim(request)` predicate ("the asking session is mine");
 * on ask it fans the question out to every claiming surface (when nobody
 * claims, to every registered surface — visible somewhere beats failing),
 * and the FIRST completed answer wins; every other surface gets
 * `settled(request, winnerName)` so it can dismiss its UI; an aborted ask
 * rejects everywhere (surfaces also observe the request's own signal).
 *
 * Coexistence is the point: UIs answer side by side on the waterfall, so the
 * router can even multiplex for a web profile; with zero surfaces it
 * delegates via next().
 */

import { Context } from '@deepseek-ai/cordis'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'

/** One interaction surface able to render and answer ask-user questions. */
export interface AskSurface {
  /** Stable display name (used in "answered on X" notices). */
  readonly name: string
  /** Whether this surface currently drives the asking agent's session. */
  claim(request: AskUserQuestionRequest): boolean
  /** Render the question and resolve with the human's answer. */
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
  /** Another surface answered first — dismiss the rendered question. */
  settled?(request: AskUserQuestionRequest, by: string): void
}

/** The registry surface UIs register against (ctx.get('askSurfaces')). */
export interface AskSurfaces {
  register(surface: AskSurface): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    askSurfaces: AskSurfaceRegistry
  }
}

/**
 * Plain registry (no Service base — trivially unit-testable); apply()
 * provides it under `askSurfaces` so surfaces find it via ctx.get().
 */
export class AskSurfaceRegistry {
  private readonly surfaces: AskSurface[] = []

  register(surface: AskSurface): () => void {
    this.surfaces.push(surface)
    return () => {
      const index = this.surfaces.indexOf(surface)
      if (index >= 0) this.surfaces.splice(index, 1)
    }
  }

  /** Snapshot of the registered surfaces in registration order. */
  list(): readonly AskSurface[] {
    return [...this.surfaces]
  }
}

/** claim() guarded: a throwing surface claims nothing. */
function safeClaim(surface: AskSurface, request: AskUserQuestionRequest): boolean {
  try {
    return surface.claim(request) === true
  } catch {
    return false
  }
}

/** settled() guarded: a throwing dismissal never breaks the winner. */
function safeSettled(surface: AskSurface, request: AskUserQuestionRequest, by: string): void {
  try {
    surface.settled?.(request, by)
  } catch {
    // contained — the losing surface's cleanup is best-effort
  }
}

/** Best-effort settled() dispatcher shape shared by raceAsk and routeAsk. */
type SettleSurface = (surface: AskSurface, request: AskUserQuestionRequest, by: string) => void

/**
 * Label passed to `settled()` when the downstream answerer (not a router
 * surface) wins the race. Surfaces use it in "answered elsewhere" notices.
 */
const DOWNSTREAM_SETTLED_BY = 'downstream answerer'

/**
 * Per-race dispatcher: settled() fires at most once per surface. The race's
 * downstream mass-dismiss and routeAsk's loser dismissal share this dispatcher,
 * so a zombie surface answer arriving after a downstream win cannot re-settle
 * a surface that was already dismissed. The Set is race-scoped: concurrent
 * races never share state, and it is released once the race's promises settle.
 */
function settledOnceDispatcher(): SettleSurface {
  const done = new Set<AskSurface>()
  return (surface, request, by) => {
    if (done.has(surface)) return
    done.add(surface)
    safeSettled(surface, request, by)
  }
}

/**
 * Dismiss every router surface, e.g. when the downstream answerer wins.
 * `settle` is the race's at-most-once dispatcher, so these dismissals also
 * pre-empt any later settled() that a zombie surface answer would trigger.
 */
function dismissSurfaces(
  surfaces: readonly AskSurface[],
  request: AskUserQuestionRequest,
  settle: SettleSurface,
): void {
  for (const surface of surfaces) settle(surface, request, DOWNSTREAM_SETTLED_BY)
}

/** True only for the framework's signal-abort rejection. */
function isAbortError(error: unknown): boolean {
  return error instanceof UserQuestionError && error.code === 'ASK_ABORTED'
}

/**
 * Race the router's own surfaces against the rest of the waterfall.
 *
 * The host 0.2.2-rc.x client bridge claims and consumes `user-questions/request`
 * without ever calling `next()`, so a tail-registered router answerer is
 * silently skipped on sessions the GUI has opened. Registering with
 * `{ prepend: true }` puts us ahead of that bridge; this arbiter then lets the
 * two answerers coexist: both branches are forked in the same tick and the
 * first terminal outcome wins, exactly one `next()` is ever issued.
 *
 * - surface branch wins  -> return its answer; a late downstream result or
 *   rejection is swallowed (the losing surfaces are already settled inside
 *   routeAsk).
 * - downstream wins      -> dismiss every surface via settled(), return its
 *   answer. A late surface answer is ignored by the one-way gate.
 * - surface rejects (non-abort) -> that branch is dead; fall back to and wait
 *   for downstream. If both reject, surface's error code wins unless the
 *   request signal was aborted, in which case ASK_ABORTED is propagated.
 *
 * `request.signal` is never aborted by us — it belongs to the dispatcher.
 */
export function raceAsk(
  surfaces: readonly AskSurface[],
  request: AskUserQuestionRequest,
  next: () => Promise<AskUserQuestionAnswer>,
): Promise<AskUserQuestionAnswer> {
  return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
    // At-most-once settled() per surface, scoped to this race. Shared by the
    // downstream mass-dismiss and routeAsk so a zombie answer after a
    // downstream win cannot re-settle a surface already dismissed.
    const settleOnce = settledOnceDispatcher()

    // One-way gate: the first terminal outcome wins; every later settlement is
    // ignored. Tracking both branches also resolves the double-reject state.
    let settled = false
    let surfaceRejected = false
    let surfaceError: unknown
    let downstreamRejected = false
    let downstreamError: unknown

    const abortError = (): UserQuestionError =>
      new UserQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED')

    const decideDoubleReject = (): void => {
      if (settled) return
      settled = true
      if (request.signal?.aborted === true) {
        reject(surfaceError !== undefined && isAbortError(surfaceError) ? surfaceError : abortError())
        return
      }
      // Surface code (e.g. NO_CHAT) is the most diagnostic single failure.
      if (surfaceError instanceof Error) reject(surfaceError)
      else if (downstreamError instanceof Error) reject(downstreamError)
      else reject(new UserQuestionError('every answerer failed', 'NO_ANSWER'))
    }

    // Surface branch: deferred to a microtask so next() starts synchronously.
    const surface = Promise.resolve().then(() => routeAsk(surfaces, request, settleOnce))
    surface.then(
      answer => {
        if (settled) return
        settled = true
        resolve(answer) // routeAsk already settled the losing surfaces
      },
      error => {
        surfaceRejected = true
        surfaceError = error
        if (settled) return
        // Signal abort is terminal: the surface's ASK_ABORTED must not be
        // swallowed by a downstream rejection that happened to arrive first.
        if (request.signal?.aborted === true) {
          settled = true
          reject(isAbortError(error) ? error : abortError())
          return
        }
        // Non-abort surface failure: dead branch, wait for downstream (R-D).
        if (downstreamRejected) decideDoubleReject()
      },
    )

    // Downstream branch: next() runs synchronously, exactly once, this tick.
    // Wrapping in a Promise turns a synchronous throw into a rejection (R-D).
    const downstream = new Promise<AskUserQuestionAnswer>(r => r(next()))
    downstream.then(
      answer => {
        if (settled) return
        settled = true
        dismissSurfaces(surfaces, request, settleOnce) // downstream beat every surface
        resolve(answer)
      },
      error => {
        downstreamRejected = true
        downstreamError = error
        if (settled) return
        if (surfaceRejected) decideDoubleReject()
        // else surface still pending — let it decide (also survives unload)
      },
    )
  })
}

/**
 * Route one ask: fan out to the claiming surfaces (all registered when
 * nobody claims), first answer wins, losers get settled(). Resolves the
 * outer promise exactly once; failures only reject when EVERY target failed.
 */
export function routeAsk(
  surfaces: readonly AskSurface[],
  request: AskUserQuestionRequest,
  settle: SettleSurface = safeSettled,
): Promise<AskUserQuestionAnswer> {
  return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
    if (surfaces.length === 0) {
      reject(new UserQuestionError('no ask surface is registered in this process', 'NO_PROVIDER'))
      return
    }
    const claimants = surfaces.filter(surface => safeClaim(surface, request))
    const targets = claimants.length > 0 ? claimants : surfaces
    let settled = false
    const failures: unknown[] = []
    for (const surface of targets) {
      Promise.resolve()
        .then(() => surface.ask(request))
        .then(answer => {
          if (settled) return
          settled = true
          for (const other of targets) {
            if (other !== surface) settle(other, request, surface.name)
          }
          resolve(answer)
        }, error => {
          if (settled) return
          failures.push(error)
          if (failures.length >= targets.length) {
            settled = true
            reject(failures[0] instanceof Error
              ? failures[0]
              : new UserQuestionError('every ask surface failed', 'NO_ANSWER'))
          }
        })
    }
    request.signal?.addEventListener('abort', () => {
      if (settled) return
      settled = true
      reject(new UserQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED'))
    }, { once: true })
  })
}

export const inject = ['userQuestions']

/** The 'user-questions/request' cordis waterfall seam. */
interface UserQuestionsWaterfallSeam {
  on(
    event: 'user-questions/request',
    listener: (
      request: AskUserQuestionRequest,
      next: () => Promise<AskUserQuestionAnswer>,
    ) => Promise<AskUserQuestionAnswer>,
    options?: boolean | { prepend?: boolean; global?: boolean },
  ): () => boolean
}

export function apply(ctx: Context): void {
  const registry = new AskSurfaceRegistry()
  ctx.provide('askSurfaces', registry)
  const route = (request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => routeAsk(registry.list(), request)
  // Answerers compose on the Agent-scoped 'user-questions/request' cordis
  // waterfall: answer by returning, delegate with next(). Register with
  // `prepend: true` so we run ahead of the host's client bridge, which on
  // 0.2.2-rc.x claims and consumes the request without calling next() on
  // GUI-opened sessions. We deliberately do NOT set `global`: that option
  // only changes dispatch filtering, and leaving it off preserves the scope
  // filter (and therefore today's receive semantics). With surfaces present
  // we race them against the downstream answerer; with zero surfaces we step
  // aside via next() exactly as before.
  const waterfall = ctx as unknown as UserQuestionsWaterfallSeam
  const dispose = waterfall.on('user-questions/request', (request, next) => {
    const surfaces = registry.list()
    return surfaces.length === 0 ? next() : raceAsk(surfaces, request, next)
  }, { prepend: true })
  ctx.effect(() => dispose)
}
